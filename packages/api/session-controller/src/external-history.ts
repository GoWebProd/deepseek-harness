/** Effect-owned external display sources, separate from native Session journals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { addressId } from './history.ts'
import type { SessionAddress, SessionWireHeader } from './types.ts'
import type {
  ExternalHistoryFrame, ExternalHistoryInfo, ExternalHistoryInfoRequest, ExternalHistoryObserveRequest,
  ExternalHistoryPage, ExternalHistoryPageRequest,
} from './external-history-types.ts'

/** One provider-owned display source; reads must observe cancellation without stopping execution. */
export interface ExternalHistorySource {
  readonly header: SessionWireHeader
  /** Read a page without materializing a native journal.
   * @param request - bounded opaque page window.
   * @param signal - read cancellation.
   * @returns a display page.
   */
  page(request: ExternalHistoryPageRequest, signal: AbortSignal): Promise<ExternalHistoryPage>
  /** Observe display data independently of Agent execution.
   * @param request - reconnect position.
   * @param signal - subscription lifetime.
   * @returns snapshot-first display changes.
   */
  observe(request: ExternalHistoryObserveRequest, signal: AbortSignal): AsyncIterable<ExternalHistoryFrame>
  /** Attach this source's engine without reading native persistence.
   * @param signal - activation cancellation.
   * @returns this source's live Agent.
   */
  activate(signal: AbortSignal): Promise<Agent>
}

/** Provider resolution is passive; undefined delegates an unclaimed identity to native Sessions. */
export interface ExternalHistoryProvider {
  readonly id: string
  /** Resolve ownership without activating an Agent.
   * @param address - authorized Harness identity.
   * @param signal - lookup cancellation.
   * @returns a claimed source or undefined.
   */
  resolve(address: SessionAddress, signal: AbortSignal): Promise<ExternalHistorySource | undefined>
}

interface Entry {
  readonly provider: ExternalHistoryProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<unknown>>
  readonly streams: Set<() => Promise<void>>
  readonly activations: Map<SessionId, Promise<Agent>>
  closing?: Promise<void>
}

interface ResolvedSource {
  readonly entry: Entry
  readonly source: ExternalHistorySource
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionHistory: ExternalHistoryController
  }
}

/** Registry ownership covers provider calls and upstream iterators, never Agent execution. */
export class ExternalHistoryController extends TypertRemoteService {
  private readonly entries = new Map<string, Entry>()
  private readonly claimed = new Set<SessionId>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Session Controller lifetime owner. */
  constructor(ctx: Context) {
    super(ctx, 'sessionHistory', { namespace: 'sessionHistory' })
    ctx.effect(() => () => {
      this.lifetime.abort()
      return drain([...this.entries.values()].map(entry => this.close(entry)))
    }, 'session.external-history')
  }

  /** Scope provider reads and subscriptions to their registering plugin.
   * @param owner - registering plugin context.
   * @param provider - passive resolver.
   * @returns awaited provider teardown.
   */
  register(owner: Context, provider: ExternalHistoryProvider): () => Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error('Session external history registry is disposed')
    if (this.entries.has(provider.id)) throw new Error(`External history provider "${provider.id}" is already registered`)
    const entry: Entry = { provider, lifetime: new AbortController(), pending: new Set(), streams: new Set(), activations: new Map() }
    const dispose = owner.effect(() => {
      this.entries.set(provider.id, entry)
      return () => this.close(entry)
    }, `session.external-history.register(${provider.id})`)
    return async () => { await dispose() }
  }

  /** Discover display ownership without reading history or activating an Agent.
   * @param request - authorized identity.
   * @param signal - discovery cancellation.
   * @returns the selected display family.
   */
  @Remote({ resources: { session: request => addressId(request.address) } })
  async info(request: ExternalHistoryInfoRequest, signal: AbortSignal): Promise<ExternalHistoryInfo> {
    const found = await this.resolve(request.address, signal)
    return found === undefined ? { kind: 'native' } : { kind: 'external', sourceId: found.entry.provider.id,
      header: found.source.header, capabilities: { nativeJournal: false } }
  }

  /** Read one provider-owned display window.
   * @param request - authorized page window.
   * @param signal - read cancellation.
   * @returns provider-owned display data.
   */
  @Remote({ resources: { session: request => addressId(request.address) } })
  async page(request: ExternalHistoryPageRequest, signal: AbortSignal): Promise<ExternalHistoryPage> {
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1))
      throw new RemoteError('gateway/bad-request', 'External history limit must be a positive safe integer', {})
    const found = await this.require(request.address, signal)
    return this.run(found.entry, signal, readSignal => found.source.page(request, readSignal))
  }

  /** Observe a provider without acquiring or stopping its Agent.
   * @param request - authorized reconnect position.
   * @param signal - observation lifetime.
   * @returns snapshot-first display frames.
   */
  @Remote({ mode: 'stream', resources: { session: request => addressId(request.address) } })
  async *observe(request: ExternalHistoryObserveRequest, signal: AbortSignal): AsyncIterable<ExternalHistoryFrame> {
    const found = await this.require(request.address, signal)
    const combined = AbortSignal.any([signal, found.entry.lifetime.signal])
    const iterator = found.source.observe(request, combined)[Symbol.asyncIterator]()
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= Promise.resolve().then(() => iterator.return?.()).then(() => {})
    found.entry.streams.add(close)
    try {
      let opened = false
      for (;;) {
        const next = await this.run(found.entry, combined, () => iterator.next())
        if (next.done) return
        if (!opened && next.value.type !== 'replace') throw new RemoteError('gateway/internal', 'External history observation omitted its opening snapshot', {})
        opened = true
        yield next.value
      }
    } finally {
      found.entry.streams.delete(close)
      await close()
    }
  }

  /** Deduplicate concurrent external activation without a native persistence read.
   * @param sessionId - ordinary Session identity.
   * @param signal - cancellation of this caller's wait.
   * @returns an external Agent or native delegation.
   */
  async activate(sessionId: SessionId, signal: AbortSignal = this.lifetime.signal): Promise<Agent | undefined> {
    const found = await this.resolve({ kind: 'session', sessionId }, signal)
    if (found === undefined) return undefined
    let activation = found.entry.activations.get(sessionId)
    if (activation === undefined) {
      activation = this.run(found.entry, found.entry.lifetime.signal, activateSignal => found.source.activate(activateSignal))
        .finally(() => { found.entry.activations.delete(sessionId) })
      found.entry.activations.set(sessionId, activation)
    }
    const agent = await waitForCaller(activation, signal)
    if (agent.id !== sessionId || agent.session.header.id !== sessionId || agent.session.header.origin === 'subagent')
      throw new RemoteError('gateway/internal', 'External history activation returned another Session identity', {})
    return agent
  }

  /** Reject use of display positions in a native journal operation.
   * @param sessionId - native operation target.
   * @param operation - operation name.
   * @param signal - lookup cancellation.
   */
  async assertNative(sessionId: SessionId, operation: string, signal: AbortSignal = this.lifetime.signal): Promise<void> {
    if (await this.resolve({ kind: 'session', sessionId }, signal))
      throw new RemoteError('session/external-history-unsupported', 'This operation requires native Session journal positions', { sessionId, operation })
  }

  private async require(address: SessionAddress, signal: AbortSignal): Promise<ResolvedSource> {
    const found = await this.resolve(address, signal)
    if (found === undefined) throw new RemoteError('session/external-history-unavailable', 'No external history provider owns this Session', { sessionId: addressId(address) })
    return found
  }

  private async resolve(address: SessionAddress, signal: AbortSignal): Promise<ResolvedSource | undefined> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    let found: ResolvedSource | undefined
    for (const entry of [...this.entries.values()]) {
      const source = await this.run(entry, signal, readSignal => entry.provider.resolve(address, readSignal))
      if (source === undefined) continue
      if (found !== undefined) throw new RemoteError('session/external-history-ambiguous', 'Several external history providers own this Session', { sessionId: addressId(address) })
      if (source.header.id !== addressId(address) || source.header.cwd === undefined)
        throw new RemoteError('gateway/internal', 'External history provider returned another Session identity or no working directory', {})
      if (address.kind === 'subagent' || source.header.origin === 'subagent')
        throw new RemoteError('session/external-history-unsupported', 'External subagent history requires its own ownership validation', { sessionId: addressId(address), operation: 'subagent-history' })
      found = { entry, source }
    }
    found?.entry.lifetime.signal.throwIfAborted()
    if (found !== undefined) this.claimed.add(addressId(address))
    else if (this.claimed.has(addressId(address))) throw new RemoteError('session/external-history-unavailable', 'The external history provider for this Session is unavailable', { sessionId: addressId(address) })
    return found
  }

  private run<T>(entry: Entry, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, entry.lifetime.signal])
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return task(combined) })
      .then((value) => { combined.throwIfAborted(); return value })
    entry.pending.add(pending)
    const settled = (): void => { entry.pending.delete(pending) }
    void pending.then(settled, settled)
    return pending
  }

  private close(entry: Entry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing
    this.entries.delete(entry.provider.id)
    entry.closing = Promise.resolve().then(() => {
      entry.lifetime.abort(new RemoteError('gateway/cancelled', 'The external history provider was removed', {}))
      return drain([
        ...[...entry.streams].map(close => Promise.resolve().then(close)),
        ...[...entry.pending].map(pending => pending.then(() => {}, () => {})),
      ])
    })
    return entry.closing
  }
}

async function waitForCaller<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const value = await Promise.race([pending, cancelled.promise])
    signal.throwIfAborted()
    return value
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function drain(pending: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(pending)
  const failures: unknown[] = []
  for (const result of results) if (result.status === 'rejected') {
    const reason: unknown = result.reason
    failures.push(reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'External history cleanup failed')
}
