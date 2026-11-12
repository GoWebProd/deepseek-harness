/** Browser-safe display history whose cursors never address a native Session journal. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionAddress, SessionRequestId, SessionWireEvent, SessionWireHeader } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An external history source is absent or its registration was removed. */
    'session/external-history-unavailable': { readonly sessionId: SessionId }
    /** More than one registered provider claimed the same Session. */
    'session/external-history-ambiguous': { readonly sessionId: SessionId }
    /** A native journal operation cannot address external display positions. */
    'session/external-history-unsupported': { readonly sessionId: SessionId; readonly operation: string }
  }
}

/** Ordinary or subagent identity whose display source is being discovered. */
export interface ExternalHistoryInfoRequest {
  readonly address: SessionAddress
}

/** Source discovery never activates an Agent or reads the native journal. */
export type ExternalHistoryInfo =
  | { readonly kind: 'native' }
  | {
    readonly kind: 'external'
    readonly sourceId: string
    readonly header: SessionWireHeader
    readonly capabilities: { readonly nativeJournal: false }
  }

/** Bounded display page; neither cursor is a native event sequence number. */
export interface ExternalHistoryPageRequest extends ExternalHistoryInfoRequest {
  readonly beforeCursor?: string
  readonly generation?: string
  readonly limit?: number
}

/** Display events are transient presentation data and never enter SessionPersistence. */
export interface ExternalHistoryPage {
  readonly generation: string
  readonly entries: readonly SessionWireEvent[]
  readonly beforeCursor?: string
  readonly resumeCursor?: string
  readonly hasMore: boolean
  /** Authoritative send receipts retire local echoes without manufacturing history. */
  readonly acceptedRequestIds?: readonly SessionRequestId[]
}

/** A reconnect may supply an opaque cursor only within the named generation. */
export interface ExternalHistoryObserveRequest extends ExternalHistoryInfoRequest {
  readonly resumeCursor?: string
  readonly generation?: string
}

/** Every observation opens with replace; a later replace explicitly resets its display window. */
export type ExternalHistoryFrame =
  | { readonly type: 'replace'; readonly page: ExternalHistoryPage }
  | { readonly type: 'append'; readonly generation: string; readonly entries: readonly SessionWireEvent[]; readonly resumeCursor?: string }
  | { readonly type: 'patch'; readonly generation: string; readonly entries: readonly SessionWireEvent[]; readonly removed?: readonly number[]; readonly resumeCursor?: string }
  | { readonly type: 'input-accepted'; readonly generation: string; readonly requestIds: readonly SessionRequestId[] }
