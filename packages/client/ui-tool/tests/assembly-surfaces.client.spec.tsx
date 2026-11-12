import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { toolSessionEvents } from './tool-fixtures.client.ts'
// @vitest-environment jsdom
/** Tool assembly acceptance through the real ui-conversation host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TodoItem } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { apply as applyTool, inject as injectTool } from '../src/client/apply.ts'
import type { ToolMaterialSnapshot, ToolMaterialHandle } from '../src/client/contract/slots.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId
// jsdom omits font loading events used by the resident composer.
const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
const TODOS: TodoItem[] = [
  { content: '梳理需求', status: 'completed' },
  { content: '实现 fixture 样本', status: 'in_progress' },
  { content: '浏览器验收', status: 'pending' },
]

const todoResult = (seq: number): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId: `todo-${seq}`,
  name: 'todo_write', args: PartialArguments.fromText(JSON.stringify({ todos: TODOS })),
  call: { name: 'todo_write', argsRaw: JSON.stringify({ todos: TODOS }) },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})

const bashResult = (seq: number, callId: string, over?: Partial<ToolResultNode>): ToolResultNode => {
  const call = over?.call === undefined ? { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' } : over.call
  return {
    kind: 'tool-result', seq, time: seq * 1_000, callId,
    name: call?.name ?? '', args: call === null ? PartialArguments.EMPTY : PartialArguments.fromText(call.argsRaw),
    call,
    callTime: seq * 1_000 - 500,
    content: [{ type: 'text', text: 'total 2\ndemo.txt\n' }], isError: false,
    subCalls: [],
    ...over,
  }
}

/** Test-owned AppFrame role: declares and renders the resident conversation area. */
type AppRootProps = PropsRenderSlots<'main'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const LAYOUT_CHILDREN = {
  'main': { kind: 'keyed', scope: 'root' },
} as const

async function bench(nodes: ToolResultNode[]) {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
  runtime.remote.provideNamespaces({
    session: {
      openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
    },
  })
  runtime.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  runtime.ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn() } as never)
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
    }),
    openSession: vi.fn(),
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    events: toolSessionEvents(nodes),
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  return runtime
}

describe('todo_write assembly (product registrations, no outlet twins)', () => {
  it('reaches the keyed toolview row and the dock plan strip, and the strip follows projection retirement', async () => {
    const runtime = await bench([todoResult(3)])
    // The dock strip reads the host-computed 'todos' projection.
    runtime.sessions.behavior(SID).projections.set('todos', TODOS)
    const view = runtime.renderRoot()

    // Keyed toolview registration took the row (summary derived from args).
    const row = view.container.querySelector('[data-tool="todo_write"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('新增 3')

    // The plan strip sits in the input dock, fed by the projection
    // (default-collapsed: the header summary shows; rows appear on expand).
    const panel = view.container.querySelector('[data-testid="todo-panel"]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
    fireEvent.click(panel!.querySelector('button')!)
    expect([...panel!.querySelectorAll('li')].map(li => li.getAttribute('data-status')))
      .toEqual(['completed', 'in_progress', 'pending'])

    // Next turn retires the standing plan (host pushes null): the strip
    // clears while the historical row stays in the flow.
    await runtime.flush()
    runtime.sessions.behavior(SID).projections.set('todos', null)
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="todo-panel"]')).toBeNull()
    })
    expect(view.container.querySelector('[data-tool="todo_write"]')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('terminal card assembly', () => {
  it('loads source-owned material inside one native call and retires it with the provider', async () => {
    const original = bashResult(3, 'lazy', { content: [{ type: 'text', text: 'preview output' }] })
    const runtime = await bench([original, bashResult(4, 'ordinary')])
    const labels = { loadingLabel: '加载中…', retryLabel: '重试' }
    const state = createSnapshotStore<ToolMaterialSnapshot>({ ...labels, expanded: false, loading: false, error: '' })
    const full = { ...original, content: [{ type: 'text' as const, text: 'complete source output' }] }
    const dispose = vi.fn()
    const setExpanded = vi.fn((expanded: boolean) => { state.set({ ...labels, expanded, loading: expanded, error: '' }) })
    const material: ToolMaterialHandle = {
      getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener),
      activate: vi.fn(), dispose, setExpanded,
      retry: vi.fn(function (this: ToolMaterialHandle) { expect(this).toBe(material) }),
    }
    const remove = runtime.ctx.uiSession.provide({ props: ['createToolMaterial'], resolve: () => ({ props: {
      createToolMaterial: (_source: unknown, callId: string) => callId === 'lazy' ? material : undefined,
    } }) })
    const view = runtime.renderRoot()
    expect(setExpanded).toHaveBeenCalledWith(false)
    expect(view.queryByText('complete source output')).toBeNull()
    const row = view.container.querySelector('[data-chat-call-id="lazy"]')!
    fireEvent.click(row.querySelector('[data-expandable]')!)
    await waitFor(() => { expect(row.querySelector('[role="status"]')).not.toBeNull() })
    act(() => { state.set({ ...labels, expanded: true, loading: false, error: 'Source read failed' }) })
    expect(row.querySelector('[role="alert"]')?.textContent).toBe('Source read failed')
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '重试' }))
    expect(material.retry).toHaveBeenCalledOnce()
    act(() => { state.set({ ...labels, expanded: true, loading: false, error: '', block: full }) })
    await waitFor(() => { expect(row.textContent).toContain('complete source output') })
    expect(view.container.querySelectorAll('[data-chat-call-id="lazy"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-chat-call-id="ordinary"]')).toHaveLength(1)
    remove()
    await waitFor(() => { expect(dispose).toHaveBeenCalled() })
    expect(view.container.querySelector('[data-chat-call-id="lazy"]')!.textContent).not.toContain('complete source output')
    await runtime.dispose()
  })

  it('both the keyed bash row and the fallback row reach the terminal card through the whole-row expand', async () => {
    const runtime = await bench([
      bashResult(3, 'c-keyed'),
      // pwsh has no package-local keyed row, so GenericToolCard owns its raw terminal card.
      bashResult(4, 'c-fallback', {
        call: { name: 'pwsh', argsRaw: '{"command":"ls -la","description":"List files"}' },
      }),
    ])
    const view = runtime.renderRoot()

    // Keyed BashRow: collapsed by default, the whole summary row is the toggle.
    const keyedRow = view.container.querySelector('[data-sample="bash"]')
    const keyed = keyedRow?.parentElement
    expect(keyed?.querySelector('[data-terminal]')).toBeNull()
    fireEvent.click(keyedRow!)
    await waitFor(() => {
      expect(keyed!.querySelector('[data-terminal]')).not.toBeNull()
    })

    // Fallback row: same unified expand interaction.
    const fallback = view.container.querySelector('[data-tool="pwsh"]')
    expect(fallback).not.toBeNull()
    expect(fallback!.querySelector('[data-terminal]')).toBeNull()
    fireEvent.click(fallback!.querySelector('[data-expandable]')!)
    await waitFor(() => {
      expect(fallback!.querySelector('[data-terminal]')).not.toBeNull()
    })
    await runtime.dispose()
  })
})
