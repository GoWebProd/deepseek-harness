import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { ExternalHistoryController } from '../src/external-history.ts'
import type { ExternalHistorySource } from '../src/external-history.ts'
import type { ExternalHistoryFrame, ExternalHistoryPage } from '../src/external-history-types.ts'
import { HistoryController } from '../src/history/controller.ts'
import { StateController } from '../src/state/controller.ts'
import { WebController } from '../src/web/controller.ts'
import { createSessionTestController, installSessionReadTestServices } from './test-remote.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Guest used only by external history access checks. */
    'external-history-test': { readonly kind: 'external-history-test' }
  }
}

const id = SessionId('external-source')
const address = { kind: 'session' as const, sessionId: id }
const signal = (): AbortSignal => new AbortController().signal
const roots: Context[] = []
const aborters: AbortController[] = []
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function page(seq = 200): ExternalHistoryPage {
  return { generation: 'source-generation', entries: [{ seq, time: 1, type: 'plugin:fixture/message', ignorable: true, data: { text: 'external history' } }],
    beforeCursor: 'opaque-before', resumeCursor: 'opaque-resume', hasMore: true }
}

function source(overrides: Partial<ExternalHistorySource> = {}): ExternalHistorySource {
  return { header: { version: 3, id, createdAt: 1, cwd: '/external', isSeeded: false },
    page: vi.fn(async () => page()),
    observe: async function* () { yield { type: 'replace', page: page() } },
    activate: vi.fn(async (): Promise<Agent> => { throw new Error('Unexpected activation') }), ...overrides }
}

function fixture() {
  const ctx = new Context(); roots.push(ctx)
  const registry = new ExternalHistoryController(ctx)
  return { ctx, registry }
}

function waitForAbort(abort: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    const aborted = (): void => {
      const reason: unknown = abort.reason
      reject(reason instanceof Error ? reason : new Error('Read cancelled'))
    }
    if (abort.aborted) aborted()
    else abort.addEventListener('abort', aborted, { once: true })
  })
}

describe('External history sources', () => {
  it('discovers and pages without activation or native history and keeps opaque cursors separate', async () => {
    const f = fixture(); const external = source(); const abort = signal()
    const read = vi.spyOn(external, 'page'); const activate = vi.spyOn(external, 'activate')
    f.registry.register(f.ctx, { id: 'fixture', resolve: async requested => requested.kind === 'session' && requested.sessionId === id ? external : undefined })
    expect(await f.registry.info({ address }, abort)).toEqual({ kind: 'external', sourceId: 'fixture', header: external.header, capabilities: { nativeJournal: false } })
    const request = { address, beforeCursor: 'opaque-cursor', generation: 'source-generation', limit: 100 }
    expect(await f.registry.page(request, abort)).toEqual(page())
    expect(read).toHaveBeenCalledWith(request, expect.any(AbortSignal)); expect(activate).not.toHaveBeenCalled()
    expect(await f.registry.info({ address: { kind: 'session', sessionId: SessionId('native') } }, abort)).toEqual({ kind: 'native' })
    await expect(f.registry.page({ address, limit: 0 }, abort)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('rejects ambiguous ownership, another returned identity and external subagent addressing', async () => {
    const f = fixture(); const external = source()
    const remove = f.registry.register(f.ctx, { id: 'first', resolve: async () => external })
    const second = f.registry.register(f.ctx, { id: 'second', resolve: async () => external })
    await expect(f.registry.info({ address }, signal())).rejects.toMatchObject({ code: 'session/external-history-ambiguous' })
    expect(() => f.registry.register(f.ctx, { id: 'second', resolve: async () => external })).toThrow(/already registered/)
    await second(); await remove()
    const wrong = f.registry.register(f.ctx, { id: 'wrong', resolve: async () => source({ header: { ...external.header, id: SessionId('another') } }) })
    await expect(f.registry.info({ address }, signal())).rejects.toMatchObject({ code: 'gateway/internal' }); await wrong()
    f.registry.register(f.ctx, { id: 'child', resolve: async () => external })
    await expect(f.registry.info({ address: { kind: 'subagent', parentSessionId: SessionId('parent'), childSessionId: id, mode: 'unknown' } }, signal()))
      .rejects.toMatchObject({ code: 'session/external-history-unsupported' })
  })

  it('cancels and drains a pending provider read before unregister resolves', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>(); const cleaned = vi.fn()
    const external = source({ page: async (_request, abort) => {
      entered.resolve(undefined)
      try { await waitForAbort(abort) } finally { cleaned() }
      return page()
    } })
    const remove = f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const read = f.registry.page({ address }, signal()); const observed = expect(read).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await entered.promise; await remove(); await observed
    expect(cleaned).toHaveBeenCalledOnce()
    await expect(f.registry.info({ address }, signal())).rejects.toMatchObject({ code: 'session/external-history-unavailable' })
    await expect(f.registry.page({ address }, signal())).rejects.toMatchObject({ code: 'session/external-history-unavailable' })
  })

  it('cancels a caller read independently of the provider and never activates execution', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>(); const abort = new AbortController()
    const external = source({ page: async (_request, readSignal) => {
      entered.resolve(undefined)
      await waitForAbort(readSignal)
      return page()
    } })
    const activate = vi.spyOn(external, 'activate')
    f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const read = f.registry.page({ address }, abort.signal); const observed = expect(read).rejects.toThrow('Read closed')
    await entered.promise; abort.abort(new Error('Read closed')); await observed
    expect(activate).not.toHaveBeenCalled(); expect((await f.registry.info({ address }, signal())).kind).toBe('external')
  })

  it('preserves snapshot, append, patch and explicit receipts and closes a paused upstream iterator on removal', async () => {
    const f = fixture(); const cleaned = vi.fn()
    const frames: ExternalHistoryFrame[] = [{ type: 'replace', page: page() }, { type: 'append', generation: 'source-generation', entries: page(201).entries },
      { type: 'patch', generation: 'source-generation', entries: page(200).entries, removed: [199] },
      { type: 'input-accepted', generation: 'source-generation', requestIds: [] }]
    const external = source({ observe: async function* () { try { yield* frames } finally { cleaned() } } })
    const remove = f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const stream = f.registry.observe({ address }, signal())[Symbol.asyncIterator]()
    for (const frame of frames) expect((await stream.next()).value).toEqual(frame)
    await remove(); expect(cleaned).toHaveBeenCalledOnce(); await stream.return?.()
  })

  it('drains a pending observation on provider removal and rejects an opening append', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>(); const cleaned = vi.fn()
    const external = source({ observe: async function* (_request, abort) { try { yield { type: 'replace', page: page() }; entered.resolve(undefined); await waitForAbort(abort) } finally { cleaned() } } })
    const remove = f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const stream = f.registry.observe({ address }, signal())[Symbol.asyncIterator]()
    await stream.next(); const next = stream.next(); const rejected = expect(next).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await entered.promise; await remove(); await rejected; expect(cleaned).toHaveBeenCalledOnce()
    f.registry.register(f.ctx, { id: 'invalid', resolve: async () => source({ observe: async function* () { yield { type: 'append', generation: 'g', entries: [] } } }) })
    await expect(f.registry.observe({ address }, signal())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('drains other streams and reads when an upstream return throws synchronously', async () => {
    const f = fixture(); const returned = vi.fn(); const cleaned = vi.fn(); const entered = Promise.withResolvers<undefined>()
    let reentrant: Promise<void> | undefined
    const external = source({
      observe(request, _abort) {
        if (request.resumeCursor === 'throws') return { [Symbol.asyncIterator]() { return {
          async next() { return { done: false, value: { type: 'replace', page: page() } } as const },
          return(): Promise<IteratorResult<ExternalHistoryFrame>> { returned(); throw new Error('Upstream close failed') },
        } } }
        return (async function* () { try { yield { type: 'replace', page: page() } as const } finally { cleaned() } })()
      },
      page: async (_request, abort) => {
        abort.addEventListener('abort', () => { reentrant = remove(); void reentrant.catch(() => {}) }, { once: true })
        entered.resolve(undefined)
        await waitForAbort(abort)
        return page()
      },
    })
    const remove = f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const bad = f.registry.observe({ address, resumeCursor: 'throws' }, signal())[Symbol.asyncIterator]()
    const good = f.registry.observe({ address }, signal())[Symbol.asyncIterator]()
    await bad.next(); await good.next()
    const read = f.registry.page({ address }, signal()); const rejected = expect(read).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await entered.promise
    await expect(remove()).rejects.toThrow('External history cleanup failed'); await rejected
    await reentrant?.catch(() => {})
    expect(returned).toHaveBeenCalledOnce(); expect(cleaned).toHaveBeenCalledOnce()
    await expect(bad.return?.()).rejects.toThrow('Upstream close failed'); await good.return?.()
  })

  it('propagates a claimed provider failure instead of delegating to native history', async () => {
    const f = fixture()
    f.registry.register(f.ctx, { id: 'broken', resolve: async () => { throw new Error('Provider lookup failed') } })
    await expect(f.registry.info({ address }, signal())).rejects.toThrow('Provider lookup failed')
  })

  it('rejects an ownership result whose provider was removed during another resolver', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>(); const done = Promise.withResolvers<undefined>()
    const remove = f.registry.register(f.ctx, { id: 'first', resolve: async () => source() })
    f.registry.register(f.ctx, { id: 'second', resolve: async () => { entered.resolve(undefined); await done.promise; return undefined } })
    const lookup = f.registry.info({ address }, signal())
    const rejected = expect(lookup).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await entered.promise; await remove(); done.resolve(undefined); await rejected
  })
})

describe('External activation and native isolation', () => {
  async function activeFixture() {
    const ctx = new Context(); roots.push(ctx)
    await ctx.plugin(TypertRegistry); await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(RemoteAccessService); await ctx.plugin(TypertGatewayService)
    const loop = await mountAgentLoopTestHarness(ctx); installSessionReadTestServices(ctx)
    const registry = new ExternalHistoryController(ctx)
    const activate = vi.fn((_signal: AbortSignal) => loop.create(id, {}, { cwd: '/external' }))
    const external = source({ activate })
    registry.register(ctx, { id: 'fixture', resolve: async requested => requested.kind === 'session' && requested.sessionId === id ? external : undefined })
    return { ctx, loop, registry, external, activate }
  }

  it('activates a cold external Agent once without consulting native persistence', async () => {
    const f = await activeFixture(); const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const agents = new ApiSessionAgentController(f.ctx, f.registry)
    const [first, second] = await Promise.all([agents.resolveAgent(id), agents.resolveAgent(id)])
    expect('agent' in first && first.agent.id).toBe(id); expect(second).toEqual(first)
    expect(f.activate).toHaveBeenCalledOnce(); expect(query).not.toHaveBeenCalled()
  })

  it('samples cold external state through activation and exposes only native metadata cursor', async () => {
    const f = await activeFixture(); const history = new HistoryController(f.ctx, f.registry)
    const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const state = new StateController(f.ctx, history)
    expect(await state.state({ sessionId: id }, signal())).toMatchObject({ active: true, running: false })
    expect(f.activate).toHaveBeenCalledOnce(); expect(query).not.toHaveBeenCalled()
    expect((await history.projections({ sessionId: id }, signal()))?.kind).toBe('sequenced')
  })

  it.each([0, 1])('cancels only state caller %i while sharing one provider-owned activation', async (cancelledIndex) => {
    const f = await activeFixture(); const state = new StateController(f.ctx, new HistoryController(f.ctx, f.registry))
    const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
    let activationSignal: AbortSignal | undefined
    f.activate.mockImplementation(async (abort) => {
      activationSignal = abort; entered.resolve(undefined); await release.promise
      abort.throwIfAborted()
      return f.loop.create(id, {}, { cwd: '/external' })
    })
    const callers = [new AbortController(), new AbortController()]
    const first = state.state({ sessionId: id }, callers[0]!.signal)
    await entered.promise
    const second = state.state({ sessionId: id }, callers[1]!.signal)
    const reads = [first, second]
    const cancelled = expect(reads[cancelledIndex]).rejects.toThrow('State view closed')
    callers[cancelledIndex]!.abort(new Error('State view closed'))
    await cancelled
    expect(activationSignal?.aborted).toBe(false)
    release.resolve(undefined)
    await expect(reads[1 - cancelledIndex]).resolves.toMatchObject({ active: true, running: false })
    expect(f.activate).toHaveBeenCalledOnce()
  })

  it('cancels and drains shared activation when its provider is removed', async () => {
    const f = fixture(); const entered = Promise.withResolvers<undefined>(); const cleaned = vi.fn()
    const external = source({ activate: async (abort) => {
      entered.resolve(undefined)
      try { await waitForAbort(abort) } finally { cleaned() }
      throw new Error('Unreachable activation')
    } })
    const remove = f.registry.register(f.ctx, { id: 'fixture', resolve: async () => external })
    const activation = f.registry.activate(id, signal())
    const rejected = expect(activation).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await entered.promise; await remove(); await rejected
    expect(cleaned).toHaveBeenCalledOnce()
  })

  it('does not read a cold native journal for external metadata or any native position operation', async () => {
    const f = await activeFixture(); const history = new HistoryController(f.ctx, f.registry)
    const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    expect(await history.projections({ sessionId: id }, signal())).toBeNull()
    await expect(history.events({ address }, signal())).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    await expect(history.observeEvent({ address }, signal())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    await expect(history.assistantOutput(id, -1, 100, 50, signal())).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    const web = new WebController(f.ctx, history, () => {})
    await expect(web.follow({ address }, signal())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    const controller = await createSessionTestController(f.ctx, { defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: '/external' })
    controller.registerExternalHistoryProvider({ id: 'unclaimed', resolve: async () => undefined })
    await expect(controller.fork({ sessionId: id, atSeq: 200 })).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    expect(query).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled()
  })

  it('preserves ordinary native history and native missing-session resolution', async () => {
    const f = await activeFixture(); const native = SessionId('native')
    const agent = await f.loop.create(native, {}, { cwd: '/native' }); agent.session.append('turn/start', { turn: 1 })
    const history = new HistoryController(f.ctx, f.registry)
    expect((await history.events({ address: { kind: 'session', sessionId: native } }, signal())).records[0]?.event.type).toBeDefined()
    expect(await new ApiSessionAgentController(f.ctx, f.registry).resolveAgent(SessionId('missing'))).toMatchObject({ error: { code: 'session/not-found' } })
  })

  it('never falls back to a raced live Agent after the claimed activation fails', async () => {
    const f = await activeFixture(); const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    f.activate.mockImplementation(async () => { await f.loop.create(id, {}, { cwd: '/external' }); throw new Error('Activation acknowledgement lost') })
    const result = await new ApiSessionAgentController(f.ctx, f.registry).resolveAgent(id)
    expect(result).toMatchObject({ error: { code: 'gateway/internal' } })
    expect('error' in result && result.error.message).toContain('External activation failed')
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects activation of another Agent without attempting native recovery', async () => {
    const f = await activeFixture(); const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    f.activate.mockImplementation(() => f.loop.create(SessionId('wrong-agent'), {}, { cwd: '/external' }))
    expect(await new ApiSessionAgentController(f.ctx, f.registry).resolveAgent(id)).toMatchObject({ error: { code: 'gateway/internal' } })
    expect(query).not.toHaveBeenCalled()
  })
})

it('enforces the addressed Harness Session before a non-owner provider lookup', async () => {
  const f = fixture(); await f.ctx.plugin(TypertRegistry); await f.ctx.plugin(RemoteAccessService); await f.ctx.plugin(TypertGatewayService)
  const resolve = vi.fn(async () => source())
  f.registry.register(f.ctx, { id: 'fixture', resolve })
  const bindings: RemoteAccessBinding[] = [{ role: { name: 'external-reader', resource: 'session', actions: ['sessionHistory/info', 'sessionHistory/page', 'sessionHistory/observe'] },
    resource: { kind: 'session', id } }]
  f.ctx.remoteAccess.registerPolicy('external-history-test', { bindings: () => bindings })
  const abort = new AbortController(); aborters.push(abort)
  const peer: PeerScope = { id: 'external-reader' as PeerId, ctx: f.ctx, principal: { kind: 'external-history-test' }, interactions: 'answer', signal: abort.signal, dispose: async () => {} }
  const call = (sessionId: ReturnType<typeof SessionId>) => f.ctx.typertGateway.invoke({ peer, namespace: 'sessionHistory', method: 'info', args: { request: { address: { kind: 'session', sessionId } } } })
  await expect(call(SessionId('private'))).rejects.toMatchObject({ code: 'remote-access/denied' }); expect(resolve).not.toHaveBeenCalled()
  await expect(call(id)).resolves.toMatchObject({ kind: 'external', sourceId: 'fixture' }); expect(resolve).toHaveBeenCalledOnce()
})
