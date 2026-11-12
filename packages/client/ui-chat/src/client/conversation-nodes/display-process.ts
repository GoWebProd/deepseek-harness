import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import type { ChatDisplayProcess, ChatDisplayWork } from '../contract/display-process.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    'display-process': ChatDisplayProcess
  }
}

type DisplayNode = ChatConversationViewNode & { readonly displayWork: ChatDisplayWork }

function displayNode(node: ChatConversationViewNode): node is DisplayNode {
  return node.displayWork !== undefined
}

function reply(node: ChatConversationViewNode): boolean {
  const typed = node as ChatNode
  return typed.kind === 'assistant-step' && hasAssistantReplyContent(typed.data.blocks)
}

function reasoning(node: ChatConversationViewNode): boolean {
  const typed = node as ChatNode
  return typed.kind === 'assistant-step' && typed.data.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
}

function status(node: ChatConversationViewNode): unknown {
  const typed = node as ChatNode
  return typed.kind === 'assistant-step' ? typed.data.status : undefined
}

function sameSpec(left: ChatDisplayProcess | undefined, right: ChatDisplayProcess): boolean {
  return left !== undefined && left.id === right.id && left.status === right.status
    && left.latest === right.latest && left.answerKey === right.answerKey
    && left.messageCount === right.messageCount && left.toolCallCount === right.toolCallCount
    && left.hasReasoning === right.hasReasoning
}

function sameStructure(left: ChatConversationViewNode, right: ChatConversationViewNode): boolean {
  return left.kind === right.kind && left.anchorSeq === right.anchorSeq && left.visibility === right.visibility
    && left.displayWork?.source === right.displayWork?.source
    && left.displayWork?.tailStatus === right.displayWork?.tailStatus
    && reply(left) === reply(right) && reasoning(left) === reasoning(right) && status(left) === status(right)
}

/** Session-local display grouping; streaming text reuses its existing exchange summary. */
export class DisplayProcessProjector {
  private raw = new Map<string, DisplayNode>()
  private projected = new Map<string, ChatConversationViewNode>()
  private specs = new Map<string, ChatDisplayProcess>()
  private readonly originals = new WeakMap<ChatConversationViewNode, ChatConversationViewNode>()

  /** Replace the loaded display window.
   * @param nodes - complete source window.
   * @returns nodes plus display-only disclosure controls.
   */
  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.raw = new Map(nodes.filter(displayNode).map(node => [node.key, node]))
    return [...nodes.filter(node => node.displayWork === undefined), ...this.rebuild().values()]
  }

  /** Update source nodes and their shared disclosure summaries.
   * @param nodes - changed source nodes.
   * @returns changes including retired controls.
   */
  apply(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    const external = nodes.filter(node => node.displayWork !== undefined || this.raw.has(node.key))
    if (external.length === 0) return nodes
    const stable = external.every((node) => {
      const previous = this.raw.get(node.key)
      return previous !== undefined && node.displayWork !== undefined && sameStructure(previous, node)
    })
    for (const node of external) {
      if (displayNode(node)) this.raw.set(node.key, node)
      else this.raw.delete(node.key)
    }
    if (stable) {
      return nodes.map((node) => {
        const previous = this.projected.get(node.key)
        if (node.displayWork === undefined || previous === undefined) return node
        const projected = { ...node, displayProcess: previous.displayProcess }
        this.originals.set(projected, node)
        this.projected.set(node.key, projected)
        return projected
      })
    }
    const previous = this.projected
    const next = this.rebuild()
    const changed = [...nodes.filter(node => node.displayWork === undefined)]
    for (const [key, node] of next) if (previous.get(key) !== node) changed.push(node)
    const incoming = new Set(nodes.map(node => node.key))
    for (const [key, node] of previous) if (!next.has(key) && !incoming.has(key)) changed.push({ ...node, visibility: 'hidden' })
    return changed
  }

  private rebuild(): ReadonlyMap<string, ChatConversationViewNode> {
    const bySource = new Map<string, ChatConversationViewNode[]>()
    for (const node of this.raw.values()) {
      const source = node.displayWork.source
      const nodes = bySource.get(source) ?? []
      nodes.push(node)
      bySource.set(source, nodes)
    }
    const next = new Map<string, ChatConversationViewNode>()
    const specs = new Map<string, ChatDisplayProcess>()
    for (const [source, nodes] of bySource) {
      nodes.sort((left, right) => left.anchorSeq - right.anchorSeq)
      const groups: ChatConversationViewNode[][] = []
      let current: ChatConversationViewNode[] | undefined
      for (const node of nodes) {
        if (node.visibility !== 'visible') continue
        if (node.kind === 'user' || current === undefined) { current = []; groups.push(current) }
        current.push(node)
      }
      const tailStatus = nodes.findLast(node => node.displayWork?.tailStatus !== undefined)?.displayWork?.tailStatus
      for (const [index, group] of groups.entries()) {
        const opening = group[0]
        if (opening === undefined) continue
        const latest = index === groups.length - 1
        const live = group.some(node => status(node) === 'running')
        const interrupted = group.some(node => status(node) === 'interrupted')
          || (latest && ['failed', 'cancelled', 'interrupted'].includes(tailStatus ?? ''))
        const processStatus = interrupted ? 'interrupted' : live ? 'running'
          : !latest || ['idle', 'completed'].includes(tailStatus ?? '') ? 'completed'
            : ['queued', 'running', 'waiting_input'].includes(tailStatus ?? '') ? 'running' : 'unknown'
        const replies = group.filter(reply)
        const answer = processStatus === 'completed' ? replies.at(-1) : undefined
        const id = JSON.stringify(['display-work', source, opening.key])
        const value: ChatDisplayProcess = { id, status: processStatus, latest, answerKey: answer?.key ?? null,
          messageCount: replies.length - (answer === undefined ? 0 : 1),
          toolCallCount: group.filter(node => node.kind === 'tool-call').length,
          hasReasoning: group.some(reasoning) }
        const previousSpec = this.specs.get(id)
        const spec = previousSpec !== undefined && sameSpec(previousSpec, value) ? previousSpec : value
        specs.set(id, spec)
        for (const node of group) {
          const previous = this.projected.get(node.key)
          const projected = previous?.displayProcess === spec && this.originals.get(previous) === node ? previous
            : { ...node, displayProcess: spec }
          this.originals.set(projected, node)
          next.set(node.key, projected)
        }
        const first = group.find(node => node.kind !== 'user')
        if (first === undefined || !(spec.toolCallCount || spec.hasReasoning || spec.messageCount)) continue
        const key = JSON.stringify(['display-process', id])
        const previous = this.projected.get(key)
        next.set(key, previous?.displayProcess === spec && previous.anchorSeq === first.anchorSeq - .1 ? previous : {
          key, kind: 'display-process', id, target: 'chat', anchorSeq: first.anchorSeq - .1,
          location: { kind: 'session' }, visibility: 'visible', data: spec, displayProcess: spec,
        })
      }
    }
    this.specs = specs
    this.projected = next
    return next
  }
}
