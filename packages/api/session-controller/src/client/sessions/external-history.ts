/** External display pages use opaque source cursors independently of native journal positions. */
import { RemoteStreamCarrierError, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ExternalHistoryFrame, ExternalHistoryPage } from '../../external-history-types.ts'
import type { SessionAddress, SessionRequestId, SessionWireEvent } from '../../types.ts'
import type { ClientSessionPageRequest } from '../transport.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'
import { assertSessionWireEvent } from '../session-wire-event.ts'
import { historyEntries } from './history-records.ts'
import type { SessionRemotes } from './remotes.ts'

/** Source-owned display updates, independent of native projection watermarks. */
export type ExternalHistoryChange =
  | { readonly type: 'replace' | 'prepend' | 'patch'; readonly entries: readonly SessionEventLikeEntry[]; readonly hasMore: boolean; readonly acceptedRequestIds?: readonly SessionRequestId[] }
  | { readonly type: 'append'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly type: 'input-accepted'; readonly requestIds: readonly SessionRequestId[] }

interface ExternalHistoryOptions {
  readonly publish: (change: ExternalHistoryChange) => void
  readonly failed: (error: unknown) => void
}

function protocolFailure(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {})
}

/** One retained Session generation owns the stream, its cursor window, and pending page reads. */
export class ExternalSessionHistory {
  private readonly stream: RemoteStream<ExternalHistoryFrame>
  private readiness: PromiseWithResolvers<void> | undefined
  private done: Promise<void> | undefined
  private disposed = false
  private generation: string | undefined
  private epoch = 0
  private beforeCursor: string | undefined
  private resumeCursor: string | undefined
  private firstSeq: number | undefined
  private lastSeq: number | undefined
  private hasMore = false
  private window = new Map<number, SessionWireEvent>()
  private readonly olderCursors = new Set<string>()
  private pageAbort: AbortController | undefined
  private pendingPage: Promise<void> | undefined

  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    private readonly options: ExternalHistoryOptions,
  ) {
    this.stream = remote.$stream<ExternalHistoryFrame>({
      name: 'external session history',
      open: signal => remote.sessionHistory.observe({
        address,
        ...(this.generation === undefined ? {} : { generation: this.generation }),
        ...(this.resumeCursor === undefined ? {} : { resumeCursor: this.resumeCursor }),
      }, signal),
      ended: () => new RemoteStreamCarrierError('external session history ended without a terminal result'),
    })
  }

  /** Start observation and wait for its first accepted display baseline.
   * @param _request - native window hints; external observation owns its opening size.
   * @returns completion of the first accepted display baseline.
   */
  open(_request: ClientSessionPageRequest): Promise<void> {
    if (this.readiness !== undefined) return this.readiness.promise
    this.readiness = Promise.withResolvers<void>()
    this.done = this.consume()
    return this.readiness.promise
  }

  /** Load one older source page; native beforeSeq coordinates never enter this request.
   * @param request - page size hints; the source owns its opaque before cursor.
   * @returns completion of one published or superseded page.
   */
  prepend(request: ClientSessionPageRequest): Promise<void> {
    if (this.pendingPage !== undefined) return this.pendingPage
    if (this.disposed || !this.hasMore) return Promise.resolve()
    const epoch = this.epoch
    const generation = this.generation
    const cursor = this.beforeCursor
    if (generation === undefined || cursor === undefined) return Promise.reject(protocolFailure('external history omitted its older-page cursor'))
    const abort = this.pageAbort = new AbortController()
    const pending = this.readOlder(request, generation, cursor, epoch, abort.signal).catch((error: unknown) => {
      if (!this.disposed && !abort.signal.aborted && epoch === this.epoch) this.options.failed(error)
      throw error
    }).finally(() => {
      if (this.pendingPage === pending) this.pendingPage = undefined
      if (this.pageAbort === abort) this.pageAbort = undefined
    })
    this.pendingPage = pending
    return pending
  }

  /** Cancel source reads and wait until no publication can still arrive. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.epoch++
    this.pageAbort?.abort()
    await this.stream.dispose()
    await this.done
    await this.pendingPage?.catch((_error: unknown) => { /* The page owner receives its original failure. */ })
  }

  private async consume(): Promise<void> {
    let physicalGeneration = 0
    let opened = false
    try {
      for await (const item of this.stream) {
        if (this.disposed) return
        if (physicalGeneration !== item.generation) { physicalGeneration = item.generation; opened = false }
        const frame = item.value
        if (frame.type === 'replace') {
          this.replace(frame.page)
          opened = true
          item.accept()
          this.readiness?.resolve()
          continue
        }
        if (!opened || frame.generation !== this.generation) throw protocolFailure('external history update does not match its opening generation')
        if (frame.type === 'input-accepted') { this.options.publish({ type: 'input-accepted', requestIds: frame.requestIds }); continue }
        if (frame.type === 'patch') {
          this.entries([...frame.entries].sort((left, right) => left.seq - right.seq))
          if (frame.removed?.some(seq => !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0))) throw protocolFailure('external history patch removed an invalid display position')
          for (const seq of frame.removed ?? []) this.window.delete(seq)
          for (const entry of frame.entries) this.window.set(entry.seq, entry)
          const ordered = [...this.window.values()].sort((left, right) => left.seq - right.seq)
          this.firstSeq = ordered[0]?.seq
          this.lastSeq = ordered.at(-1)?.seq
          if (frame.resumeCursor !== undefined) this.resumeCursor = frame.resumeCursor
          this.options.publish({ type: 'patch', entries: this.entries(ordered), hasMore: this.hasMore })
          continue
        }
        const entries = this.entries(frame.entries, this.lastSeq)
        for (const entry of frame.entries) this.window.set(entry.seq, entry)
        if (this.firstSeq === undefined) this.firstSeq = entries[0]?.event.seq
        if (entries.length > 0) this.lastSeq = entries.at(-1)?.event.seq
        if (frame.resumeCursor !== undefined) this.resumeCursor = frame.resumeCursor
        this.options.publish({ type: 'append', entries })
      }
    } catch (error) {
      if (!this.disposed) { this.readiness?.reject(error); this.options.failed(error) }
    } finally {
      this.readiness?.reject(protocolFailure('external history closed before its opening baseline'))
    }
  }

  private replace(page: ExternalHistoryPage): void {
    const entries = this.entries(page.entries)
    if (page.hasMore && page.beforeCursor === undefined) throw protocolFailure('external history omitted its older-page cursor')
    this.epoch++
    this.pageAbort?.abort()
    this.generation = page.generation
    this.beforeCursor = page.beforeCursor
    this.resumeCursor = page.resumeCursor
    this.firstSeq = entries[0]?.event.seq
    this.lastSeq = entries.at(-1)?.event.seq
    this.hasMore = page.hasMore
    this.window = new Map(page.entries.map(entry => [entry.seq, entry]))
    this.olderCursors.clear()
    if (page.beforeCursor !== undefined) this.olderCursors.add(page.beforeCursor)
    this.options.publish({ type: 'replace', entries, hasMore: page.hasMore,
      ...(page.acceptedRequestIds === undefined ? {} : { acceptedRequestIds: page.acceptedRequestIds }) })
  }

  private entries(events: readonly SessionWireEvent[], after?: number): readonly SessionEventLikeEntry[] {
    let previous = after
    for (const event of events) {
      try { assertSessionWireEvent(event) } catch (_error: unknown) { throw protocolFailure('external history returned an invalid display event') }
      if (previous !== undefined && event.seq <= previous) throw protocolFailure('external history display positions are not increasing')
      previous = event.seq
    }
    return historyEntries(events.map(event => ({ type: 'event', event })))
  }

  private async readOlder(
    request: ClientSessionPageRequest, generation: string, beforeCursor: string, epoch: number, signal: AbortSignal,
  ): Promise<void> {
    const result = await this.remote.sessionHistory.page({ address: this.address, generation, beforeCursor,
      ...(request.maxMessages === undefined ? {} : { limit: request.maxMessages }) }, signal)
    if (this.disposed || signal.aborted || epoch !== this.epoch) return
    if (!result.ok) throw result.error
    const page = result.value
    if (page.generation !== generation) throw protocolFailure('external history page changed its source generation')
    const entries = this.entries(page.entries)
    const newest = entries.at(-1)?.event.seq
    if (this.firstSeq !== undefined && newest !== undefined && newest >= this.firstSeq) throw protocolFailure('external history older page overlaps the visible window')
    if (page.hasMore && (page.beforeCursor === undefined || this.olderCursors.has(page.beforeCursor))) throw protocolFailure('external history older page did not advance')
    this.beforeCursor = page.beforeCursor
    if (page.beforeCursor !== undefined) this.olderCursors.add(page.beforeCursor)
    this.hasMore = page.hasMore
    for (const entry of page.entries) this.window.set(entry.seq, entry)
    if (entries[0] !== undefined) this.firstSeq = entries[0].event.seq
    if (this.lastSeq === undefined) this.lastSeq = newest
    this.options.publish({ type: 'prepend', entries, hasMore: page.hasMore,
      ...(page.acceptedRequestIds === undefined ? {} : { acceptedRequestIds: page.acceptedRequestIds }) })
  }
}
