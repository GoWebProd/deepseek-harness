import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, ChatNode } from '../src/client/contract/chat-nodes.ts'
import { DisplayProcessProjector } from '../src/client/conversation-nodes/display-process.ts'
import { createChatStore, displayProcessOpen } from '../src/client/stores.ts'

function node(key: string, anchorSeq: number, kind: 'user' | 'assistant-step' | 'tool-call' = 'assistant-step', tailStatus?: string): ChatConversationViewNode {
  return { key, id: key, kind, target: 'chat', anchorSeq, location: { kind: 'session' }, visibility: 'visible',
    displayWork: { source: 'external', ...tailStatus === undefined ? {} : { tailStatus } },
    data: kind === 'assistant-step' ? { status: 'settled', turn: 0, step: 0, time: 0, blocks: [{ kind: 'text', text: key }] } : {} }
}

function spec(nodes: readonly ChatConversationViewNode[]) {
  return nodes.find(node => node.kind === 'display-process')!.displayProcess!
}

describe('external display process projection', () => {
  it('regroups a partial prefix when the real input arrives without changing message keys or source records', () => {
    const p = new DisplayProcessProjector()
    const tool = node('tool', 2, 'tool-call')
    const answer = node('answer', 4, 'assistant-step', 'idle')
    const first = p.replace([tool, answer])
    const before = structuredClone([tool, answer])
    expect(spec(first).status).toBe('completed')
    const next = p.replace([node('input', 0, 'user'), tool, answer])
    expect(spec(next).id).not.toBe(spec(first).id)
    expect(next.filter(node => node.kind !== 'display-process').map(node => node.key)).toEqual(['input', 'tool', 'answer'])
    expect([tool, answer]).toEqual(before)
    expect(next.every(node => node.location.kind === 'session')).toBe(true)
    expect(p.replace([node('new-generation', 30, 'assistant-step', 'idle')]).some(node => node.key === 'tool')).toBe(false)
  })

  it('settles a live reply and keeps manual choices scoped to the final reply identity', () => {
    const p = new DisplayProcessProjector()
    const live = { ...node('reply', 3, 'assistant-step', 'running'), data: { status: 'running', turn: 0, step: 0, blocks: [{ kind: 'text', text: 'part' }], time: 0 } }
    expect(spec(p.replace([node('input', 0, 'user'), node('tool', 1, 'tool-call'), live])).status).toBe('running')
    const next = p.apply([node('reply', 3, 'assistant-step', 'idle')])
    const done = spec(next)
    expect(done.status).toBe('completed'); expect(done.answerKey).toBe('reply')
    const store = createChatStore().create()
    expect(displayProcessOpen(store.getSnapshot(), done, false)).toBe(false)
    store.actions.setDisplayProcessOpen(done.id, done.answerKey, true)
    expect(displayProcessOpen(store.getSnapshot(), done, false)).toBe(true)
    expect(displayProcessOpen(store.getSnapshot(), { ...done, answerKey: 'replacement' }, false)).toBe(false)
  })

  it('retains prefix identities and publishes one node for a text delta in a long loaded history', () => {
    const p = new DisplayProcessProjector()
    const history = Array.from({ length: 10_000 }, (_, i) => node(`message-${i}`, i, i % 2 === 0 ? 'user' : 'assistant-step'))
    const live = { ...node('live', 10_001, 'assistant-step', 'running'), data: { status: 'running', turn: 0, step: 0, time: 0, blocks: [{ kind: 'text', text: 'part' }] } }
    const first = p.replace([...history, node('tool', 10_000, 'tool-call'), live])
    const updated = { ...live, data: { ...live.data, blocks: [{ kind: 'text', text: 'partial' }] } }
    const changes = p.apply([updated])
    expect(changes).toHaveLength(1)
    expect(changes[0]!.displayProcess).toBe(first.find(node => node.key === 'live')!.displayProcess)
    expect(first[0]!.key).toBe('message-0')
  })

  it('does not decorate ordinary nodes or combine different display sources', () => {
    const p = new DisplayProcessProjector()
    const ordinary = { ...node('ordinary', 50), displayWork: undefined }
    expect(p.replace([ordinary])).toEqual([ordinary])
    const a = [node('input-a', 0, 'user'), node('tool-a', 1, 'tool-call'), node('answer-a', 2, 'assistant-step', 'idle')]
    const b = [node('input-b', 3, 'user'), node('tool-b', 4, 'tool-call'), node('answer-b', 5, 'assistant-step', 'running')].map(node => ({ ...node, displayWork: { ...node.displayWork!, source: 'another' } }))
    const projected = p.replace([...a, ...b])
    const controls = projected.filter(node => node.kind === 'display-process')
    expect(controls).toHaveLength(2)
    expect(controls.map(node => node.displayProcess!.status)).toEqual(['completed', 'running'])
    const answer = projected.find(node => node.key === 'answer-a') as ChatNode<'assistant-step'>
    expect(answer.displayProcess!.latest).toBe(true)
  })
})
