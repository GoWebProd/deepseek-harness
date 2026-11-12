/** Opt-in work details for display sources without Engine Turn or Step events. */
export interface ChatDisplayWork {
  readonly source: string
  /** Latest backend run state, carried by the source's tail node only. */
  readonly tailStatus?: string
}

/** Loaded exchange summary; identities and counts describe display nodes, not model steps. */
export interface ChatDisplayProcess {
  readonly id: string
  readonly status: 'running' | 'completed' | 'interrupted' | 'unknown'
  readonly latest: boolean
  readonly answerKey: string | null
  readonly messageCount: number
  readonly toolCallCount: number
  readonly hasReasoning: boolean
}

/** Shared disclosure state passed through the existing Chat node seat. */
export interface DisplayProcessOwnerProps {
  readonly spec: ChatDisplayProcess
  readonly hasContent: boolean
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}
