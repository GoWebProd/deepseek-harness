// @vitest-environment jsdom
/** Display folding and lazy Tool material through the production Conversation and Slot assembly. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ISession, SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import {
  apply as applyConversation, inject as injectConversation, type ConversationNodeDefinitionInput,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ChatNode, type ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { apply as applyTool, inject as injectTool } from '../src/client/apply.ts'
import type { ToolMaterialHandle, ToolMaterialSnapshot } from '../src/client/contract/slots.ts'

usePinnedBrowserLanguages('zh-CN')
const SID = 'display-material' as SessionId
const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})

function AppRoot({ renderSlot }: PropsRenderSlots<'main'>) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

function FinalAction({ messageId }: PropsRuntime<'conversation.chat.assistant.actions'>) {
  return <button type="button" aria-label="Integration action" data-message-id={messageId} />
}

function exchangeFixture() {
  const source = { kind: 'integration-material', callId: 'material-call' }
  const root: ToolResultNode = {
    kind: 'tool-result', seq: 2, time: 2_000, callId: source.callId,
    name: 'material_probe', args: PartialArguments.fromText('{"query":"fixture"}'),
    call: { name: 'material_probe', argsRaw: '{"query":"fixture"}' }, callTime: 1_500,
    content: [{ type: 'text', text: 'Preview output' }], isError: false, subCalls: [],
  }
  const blocks = [{ kind: 'text' as const, text: 'Final display answer' }]
  const base = {
    target: 'chat' as const, location: { kind: 'session' as const }, visibility: 'visible' as const,
    displayWork: { source: 'integration-exchange' },
  }
  const nodes: ChatNode[] = [
    { ...base, key: 'input', id: 'input', kind: 'user', anchorSeq: 1, groupTree: 'exchange',
      data: { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'Read full Tool output' }], source: null } },
    { ...base, key: 'tool', id: 'tool', kind: 'tool-call', anchorSeq: 2, data: { root, source } },
    { ...base, key: 'answer', id: 'answer', kind: 'assistant-step', anchorSeq: 3,
      displayWork: { source: 'integration-exchange', tailStatus: 'idle' },
      data: { status: 'settled', turn: 0, step: 0, blocks, time: 3_000, source,
        finalNode: { kind: 'assistant', seq: 3, time: 3_000, turn: 0, step: 0,
          messageId: MessageId('material-answer'), blocks } } },
  ]
  const events: SessionLiveEventEntry[] = nodes.map(node => ({ type: 'event', event: {
    type: 'plugin:display-material/fixture', seq: SessionSeq(node.anchorSeq), time: node.anchorSeq * 1_000,
    ignorable: true, surfaceOp: 'append', data: {},
  } }))
  return { nodes: new Map(nodes.map(node => [String(node.anchorSeq), node])), events, root, source }
}

async function assemble(fixture: ReturnType<typeof exchangeFixture>) {
  const runtime = await SlotTestRuntime.create()
  try {
    runtime.ctx.provide('fileDrag', {
      actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} },
      read: () => undefined,
    } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
    runtime.remote.provideNamespaces({ session: {
      openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
    } })
    runtime.ctx.provide('configForms', {
      developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope,
    } as never)
    runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
    runtime.ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    runtime.ctx.provide('sidebarRight', { openResource: vi.fn() } as never)
    runtime.ctx.provide('uiWorkspace', {
      openWorkspace: vi.fn(async (_id: WorkspaceId, beforeOpen: (id: SessionId) => void) => { beforeOpen(SID) }),
      openSession: vi.fn(),
    } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
    await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
    await runtime.sessions.add({ id: SID, summary: { title: 'Display material', cwd: '/proj' }, events: fixture.events,
      session: {
        loadOlder: vi.fn<ISession['loadOlder']>(),
        prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
      } })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await runtime.root.declare({ main: { kind: 'keyed', scope: 'root' } }, AppRoot)
    await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
    const definition: ConversationNodeDefinitionInput<ChatNode> = {
      kind: 'display-material-fixture', target: 'chat',
      match: { 'plugin:display-material/fixture': event => ({ id: String(event.seq), role: 'start' }) },
      start: (context) => {
        const node = fixture.nodes.get(context.id)
        if (node === undefined) throw new Error(`Missing display fixture ${context.id}`)
        return node
      },
      update: context => context.state,
      buildViewNode: context => context.state === undefined
        ? null : { ...context.state, key: context.key, id: context.id },
    }
    runtime.ctx.uiConversation.events.register(definition)
    await runtime.mount({ inject: [...injectChat], apply: applyChat })
    await runtime.mount({ inject: [...injectTool], apply: applyTool })
    runtime.ctx.slots.register({ name: 'conversation.chat.assistant.actions', id: 'integration-action' }, FinalAction)
    return runtime
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

describe('display work with source-owned Tool material', () => {
  it('cancels the read when work folds, reopens a reset Tool and releases material on unmount', async () => {
    const fixture = exchangeFixture()
    const runtime = await assemble(fixture)
    try {
      const initial = { expanded: false, loading: false, error: '', loadingLabel: 'Loading material', retryLabel: 'Retry' }
      const state = createSnapshotStore<ToolMaterialSnapshot>(initial)
      const reads: { signal: AbortSignal; result: PromiseWithResolvers<ToolResultNode> }[] = []
      const read = vi.fn((signal: AbortSignal) => {
        const result = Promise.withResolvers<ToolResultNode>()
        reads.push({ signal, result })
        return result.promise
      })
      let active: AbortController | undefined
      const listeners = new Set<() => void>()
      const material: ToolMaterialHandle = {
        getSnapshot: () => state.getSnapshot(),
        subscribe: (listener) => {
          listeners.add(listener)
          const unsubscribe = state.subscribe(listener)
          return () => { listeners.delete(listener); unsubscribe() }
        },
        activate: vi.fn(),
        dispose: vi.fn(() => { active?.abort(); state.set(initial) }),
        setExpanded: vi.fn((expanded) => {
          if (expanded === state.getSnapshot().expanded) return
          active?.abort()
          state.set({ ...initial, expanded, loading: expanded })
          if (!expanded) return
          const controller = active = new AbortController()
          void read(controller.signal).then((block) => {
            if (!controller.signal.aborted) state.set({ ...initial, expanded: true, block })
          })
        }),
        retry: vi.fn(),
      }
      const createToolMaterial = vi.fn((_source: unknown, _callId: string) => material)
      runtime.ctx.uiSession.provide({ props: ['createToolMaterial'], resolve: () => ({ props: { createToolMaterial } }) })
      const view = runtime.renderRoot()
      const control = view.container.querySelector<HTMLButtonElement>('[data-display-process]')!
      const call = view.container.querySelector<HTMLElement>('[data-chat-call-id="material-call"]')!
      const toolSeat = call.closest<HTMLElement>('[data-chat-node-key]')!
      const answer = view.getByText('Final display answer').closest<HTMLElement>('[data-chat-node-key]')!
      const toggle = () => fireEvent.click(call.querySelector('[data-expandable]')!)
      const checkAnswer = () => {
        expect(answer.hasAttribute('hidden')).toBe(false)
        expect(answer.querySelectorAll('[data-clock] button')).toHaveLength(2)
        expect(view.getAllByRole('button', { name: 'Integration action' })).toHaveLength(1)
        expect(within(answer).getByRole('button', { name: 'Integration action' }).getAttribute('data-message-id'))
          .toBe('material-answer')
      }
      expect(control.getAttribute('aria-expanded')).toBe('false')
      expect(toolSeat.getAttribute('hidden')).toBe('until-found')
      expect(createToolMaterial).toHaveBeenCalledExactlyOnceWith(fixture.nodes.get('2')!.data, fixture.root.callId)
      expect(read).not.toHaveBeenCalled()
      checkAnswer()

      fireEvent.click(control)
      toggle()
      await waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
      expect(call.querySelector('[role="status"]')?.textContent).toBe('Loading material')
      fireEvent.click(control)
      await waitFor(() => { expect(reads[0]!.signal.aborted).toBe(true) })
      expect(toolSeat.getAttribute('hidden')).toBe('until-found')
      expect(state.getSnapshot().expanded).toBe(false)
      checkAnswer()
      await act(async () => {
        reads[0]!.result.resolve({ ...fixture.root, content: [{ type: 'text', text: 'Obsolete full output' }] })
      })
      expect(view.queryByText('Obsolete full output')).toBeNull()

      fireEvent.click(control)
      expect(toolSeat.hasAttribute('hidden')).toBe(false)
      expect(call.querySelector('[role="status"]')).toBeNull()
      expect(call.textContent).not.toContain('Preview output')
      toggle()
      await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
      expect(reads[1]!.signal.aborted).toBe(false)
      await act(async () => {
        reads[1]!.result.resolve({ ...fixture.root, content: [{ type: 'text', text: 'Complete current output' }] })
      })
      expect(call.textContent).toContain('Complete current output')
      expect(view.container.querySelectorAll('[data-chat-call-id="material-call"]')).toHaveLength(1)
      expect(createToolMaterial).toHaveBeenCalledOnce()
      checkAnswer()

      toggle()
      toggle()
      await waitFor(() => { expect(read).toHaveBeenCalledTimes(3) })
      expect(listeners.size).toBeGreaterThan(0)
      view.unmount()
      expect(listeners.size).toBe(0)
      expect(material.dispose).toHaveBeenCalledOnce()
      expect(reads[2]!.signal.aborted).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
