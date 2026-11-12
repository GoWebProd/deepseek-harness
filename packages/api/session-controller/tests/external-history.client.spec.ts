/** External display history shares the native Session lifecycle without native journal coordinates. */
import { describe, expect, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { ExternalHistoryFrame, ExternalHistoryInfo, ExternalHistoryPage } from '../src/external-history-types.ts'
import type { SessionRequestId, SessionWireEvent } from '../src/types.ts'
import { sessionBench } from './remote/bench.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const SID = 'external-fixture' as SessionId
const ADDRESS = { kind: 'session', sessionId: SID } as const
const OBSERVE = 'sessionHistory/observe'
const INFO: ExternalHistoryInfo = { kind: 'external', sourceId: 'fixture-source', capabilities: { nativeJournal: false },
  header: { version: SESSION_FORMAT_VERSION, id: SID, createdAt: 0, isSeeded: false } }

function event(seq: number): SessionWireEvent {
  return { type: 'plugin:external-fixture/message', seq, time: 1_700_000_000_000 + seq, ignorable: true, data: { text: `Message ${seq}` } }
}

function page(positions: number[], overrides: Partial<ExternalHistoryPage> = {}): ExternalHistoryPage {
  return { generation: 'source-generation-1', entries: positions.map(event), hasMore: false, ...overrides }
}

function observe(mock: RemoteMock, opening: () => ExternalHistoryPage): void {
  mock.stream(OBSERVE, async (_args, stream) => { stream.push({ type: 'replace', page: opening() }) })
}

async function push(mock: RemoteMock, frame: ExternalHistoryFrame): Promise<void> {
  mock.streams.push(OBSERVE, frame)
  await mock.streams.drained(OBSERVE)
}

describe('external Session display history', () => {
  it('discovers an external source before opening and keeps display seqs out of Host projections', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([1000, 5000], { hasMore: true, beforeCursor: 'older:opaque', resumeCursor: 'resume:opaque' }))
    session.projections.apply('title', 'Host title', SessionSeq(2))
    const feed = session.eventSource

    await session.open()

    expect(session.eventSource).toBe(feed)
    expect(feed.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([1000, 5000])
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', hasMore: true, blank: false, awaitingFirstTurn: false, historySource: INFO })
    expect(session.projections.get('title')).toBe('Host title')
    expect(session.projections.seqOf('title')).toBe(2)
    expect(mock.log.requests('session/follow')).toEqual([])
    expect(mock.log.requests('session/page')).toEqual([])
    expect(mock.remote.sessionHistory.info).toHaveBeenCalledWith({ address: ADDRESS })
  }, 60_000)

  it('prepends sparse display positions through opaque cursors and coalesces loadingOlder', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([100, 5000], { hasMore: true, beforeCursor: 'before:opaque' }))
    await session.open()
    const older = Promise.withResolvers<ReturnType<typeof ok<ExternalHistoryPage>>>()
    mock.remote.sessionHistory.page.mockReturnValueOnce(older.promise)

    const loading = session.loadOlder()
    const concurrent = session.loadOlder()
    expect(session.getSnapshot().loadingOlder).toBe(true)
    older.resolve(ok(page([2, 9])))
    await Promise.all([loading, concurrent])

    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([2, 9, 100, 5000])
    expect(session.getSnapshot()).toMatchObject({ hasMore: false, loadingOlder: false, openState: 'open' })
    expect(mock.remote.sessionHistory.page).toHaveBeenCalledOnce()
    expect(mock.remote.sessionHistory.page).toHaveBeenCalledWith({ address: ADDRESS, generation: 'source-generation-1', beforeCursor: 'before:opaque', limit: 500 })
    await expect(session.loadThrough(SessionSeq(2))).rejects.toMatchObject({ code: 'session/external-history-unsupported' })
    expect(mock.log.requests('session/page')).toEqual([])
  })

  it('holds external pages until the viewport consumes them and keeps live patches visible', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([100], { hasMore: true, beforeCursor: 'before:opaque' }))
    await session.open()
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([2, 9])))

    await session.loadOlder({ deferConsumption: true })

    expect(session.getSnapshot().historyLoadStatus).toBe('pendingConsumption')
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([100])
    const amended = { ...event(100), data: { text: 'Live patch during deferred consumption' } }
    await push(mock, { type: 'patch', generation: 'source-generation-1', entries: [event(5), amended] })
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([100])
    expect(session.eventSource.getSnapshot().entries[0]?.event.data).toEqual(amended.data)
    expect(session.consumeOlder()).toBe(true)
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([2, 5, 9, 100])
    expect(session.getSnapshot()).toMatchObject({ hasMore: false, historyLoadStatus: 'idle', historyWasPartial: true })
    expect(session.consumeOlder()).toBe(false)
  })

  it('fences an older page superseded by a same-stream display reset', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([100], { hasMore: true, beforeCursor: 'old-cursor' }))
    await session.open()
    const older = Promise.withResolvers<ReturnType<typeof ok<ExternalHistoryPage>>>()
    mock.remote.sessionHistory.page.mockReturnValueOnce(older.promise)
    const pending = session.loadOlder()
    await push(mock, { type: 'replace', page: page([7], { generation: 'source-generation-2' }) })
    older.resolve(ok(page([1])))
    await pending

    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([7])
    expect(session.getSnapshot()).toMatchObject({ hasMore: false, loadingOlder: false, openState: 'open', openError: null })
  })

  it('accepts an empty older page with cursor progress and stops a later cursor cycle', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([100], { hasMore: true, beforeCursor: 'before:one' }))
    await session.open()
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([], { hasMore: true, beforeCursor: 'before:two' })))

    await session.loadOlder()
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', hasMore: true, loadingOlder: false })
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([100])
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([], { hasMore: true, beforeCursor: 'before:one' })))
    await session.loadOlder()
    expect(session.getSnapshot().openError?.code).toBe('gateway/internal')
    expect(mock.remote.sessionHistory.page).toHaveBeenCalledTimes(2)
  })

  it('establishes the append boundary after paging an initially empty display window', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([], { hasMore: true, beforeCursor: 'before:one' }))
    await session.open()
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([2, 9])))
    await session.loadOlder()

    await push(mock, { type: 'append', generation: 'source-generation-1', entries: [event(9)] })
    await vi.waitFor(() => { expect(session.getSnapshot().openError?.code).toBe('gateway/internal') })
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([2, 9])
  })

  it('patches live text and removes a placeholder without losing loaded older pages or their cursor', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([100, 5000], { hasMore: true, beforeCursor: 'before:one' }))
    await session.open()
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([2, 9], { hasMore: true, beforeCursor: 'before:two' })))
    await session.loadOlder()

    await push(mock, { type: 'patch', generation: 'source-generation-1', entries: [event(5001), { ...event(100), data: { text: 'Streaming update' } }], removed: [5000] })

    const window = session.eventSource.getSnapshot()
    expect(window.change.kind).toBe('replace')
    expect(window.entries.map(entry => entry.event.seq)).toEqual([2, 9, 100, 5001])
    expect(window.entries[2]?.event.data).toEqual({ text: 'Streaming update' })
    expect(session.getSnapshot().hasMore).toBe(true)
    mock.remote.sessionHistory.page.mockResolvedValueOnce(ok(page([1])))
    await session.loadOlder()
    expect(mock.remote.sessionHistory.page).toHaveBeenLastCalledWith({ address: ADDRESS, generation: 'source-generation-1', beforeCursor: 'before:two', limit: 500 })
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([1, 2, 9, 100, 5001])
  })

  it('reopens a carrier generation with opaque resume metadata and one atomic replacement', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    let opening = page([100], { resumeCursor: 'resume:one' })
    observe(mock, () => opening)
    await session.open()
    await push(mock, { type: 'append', generation: 'source-generation-1', entries: [event(110)], resumeCursor: 'resume:two' })
    opening = page([5, 110], { generation: 'source-generation-2', resumeCursor: 'resume:three' })

    mock.streams.fail(OBSERVE, new RemoteStreamCarrierError('external history carrier interrupted'))
    await vi.waitFor(() => { expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([5, 110]) })

    expect(session.eventSource.getSnapshot().change.kind).toBe('replace')
    expect(mock.log.streams(OBSERVE)).toHaveLength(2)
    expect(mock.log.streams(OBSERVE)[1]?.args).toEqual([{ address: ADDRESS, generation: 'source-generation-1', resumeCursor: 'resume:two' }])
    expect(mock.log.requests('session/follow')).toEqual([])
  })

  it('retires only real accepted input receipts without manufacturing user events', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([10]))
    await session.open()
    const retired = vi.fn()
    const input = session.beginSubmission({ text: 'Sent input', mode: 'queue', attachments: [], onRetire: retired })
    await session.prompt([{ type: 'text', text: 'Sent input' }], 'queue', undefined, input.requestId)
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)

    await push(mock, { type: 'input-accepted', generation: 'source-generation-1', requestIds: ['foreign-input' as SessionRequestId] })
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1)
    await push(mock, { type: 'input-accepted', generation: 'source-generation-1', requestIds: [input.requestId] })
    await vi.waitFor(() => { expect(session.getSnapshot().pendingSubmissions).toEqual([]) })
    await push(mock, { type: 'replace', page: page([10], { acceptedRequestIds: [input.requestId] }) })

    expect(retired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [] })
    expect(session.getSnapshot().awaitingFirstTurn).toBe(false)
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.type)).toEqual(['plugin:external-fixture/message'])
  })

  for (const scenario of [
    { receipt: 'frame', dispose: false, retiredFirst: false },
    { receipt: 'frame', dispose: true, retiredFirst: true },
    { receipt: 'page', dispose: false, retiredFirst: true },
  ] as const) it(`keeps an authoritative ${scenario.receipt} receipt after a late prompt failure (disposed=${scenario.dispose})`, async ({ mock, start }) => {
    const engaged = vi.fn()
    const session = await sessionBench(mock, start, SID, { onEngaged: engaged })
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([10]))
    await session.open()
    engaged.mockClear()
    const retired = vi.fn(); const accepted = vi.fn()
    const input = session.beginSubmission({ text: 'Accepted once', mode: 'queue', attachments: [], onRetire: retired, onAccept: accepted })
    const pending = Promise.withResolvers<RemoteResult<{ accepted: true }>>()
    mock.remote.session.prompt.mockReturnValueOnce(pending.promise)
    const sending = session.prompt([{ type: 'text', text: 'Accepted once' }], 'queue', undefined, input.requestId)

    if (scenario.receipt === 'frame') await push(mock, { type: 'input-accepted', generation: 'source-generation-1', requestIds: [input.requestId] })
    else await push(mock, { type: 'replace', page: page([10], { acceptedRequestIds: [input.requestId] }) })
    if (scenario.retiredFirst) await vi.waitFor(() => { expect(retired).toHaveBeenCalledOnce() })
    await push(mock, { type: 'replace', page: page([10], { acceptedRequestIds: [input.requestId] }) })
    if (scenario.dispose) await session.dispose()
    pending.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Lost prompt acknowledgement', {}) })

    expect(await sending).toEqual(ok({ accepted: true }))
    expect(session.getSnapshot()).toMatchObject({ promptError: null, awaitingFirstTurn: false })
    await vi.waitFor(() => { expect(session.getSnapshot().pendingSubmissions).toEqual([]) })
    expect(retired).toHaveBeenCalledExactlyOnceWith({ reason: 'observed', attachments: [] })
    expect(accepted).toHaveBeenCalledOnce()
    expect(engaged).toHaveBeenCalledOnce()
    expect(mock.log.requests('session/prompt')).toHaveLength(1)
  })

  it('matches acceptance to the in-flight request even without an echo and keeps unrelated failures', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([]))
    await session.open()
    const first = Promise.withResolvers<RemoteResult<{ accepted: true }>>()
    const second = Promise.withResolvers<RemoteResult<{ accepted: true }>>()
    mock.remote.session.prompt.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const sending = session.prompt([{ type: 'text', text: 'Accepted' }], 'queue')
    const other = session.prompt([{ type: 'text', text: 'Not accepted' }], 'queue')
    const request = mock.log.requests('session/prompt')[0] as { requestId: SessionRequestId }
    await push(mock, { type: 'input-accepted', generation: 'source-generation-1', requestIds: [request.requestId, 'foreign-input' as SessionRequestId] })
    first.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Lost acknowledgement', {}) })
    expect(await sending).toEqual(ok({ accepted: true }))
    expect(session.getSnapshot().promptError).toBeNull()
    expect(session.getSnapshot()).toMatchObject({ blank: false, awaitingFirstTurn: false })

    second.resolve({ ok: false, error: new RemoteError('session/agent-busy', 'Not accepted', { reason: 'busy' }) })
    expect(await other).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send', error: { code: 'session/agent-busy' } })
    expect(mock.log.requests('session/prompt')).toHaveLength(2)
  })

  it('surfaces provider withdrawal without falling back to the native journal', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([10]))
    await session.open()

    mock.streams.fail(OBSERVE, new RemoteError('session/external-history-unavailable', 'Display source unavailable', { sessionId: SID }))
    await vi.waitFor(() => { expect(session.getSnapshot().openState).toBe('error') })

    expect(session.getSnapshot().openError?.code).toBe('session/external-history-unavailable')
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([10])
    mock.remote.sessionHistory.info.mockResolvedValueOnce(ok({ kind: 'native' }))
    await session.open()
    expect(session.getSnapshot().openError?.code).toBe('session/external-history-unavailable')
    expect(mock.log.requests('session/follow')).toEqual([])
  })

  it('disposal during discovery prevents a stale native opening', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const info = Promise.withResolvers<ReturnType<typeof ok<ExternalHistoryInfo>>>()
    mock.remote.sessionHistory.info.mockReturnValueOnce(info.promise)
    const opening = session.open()
    const disposal = session.dispose()
    info.resolve(ok({ kind: 'native' }))
    await Promise.all([opening, disposal])

    expect(mock.log.requests('session/follow')).toEqual([])
    expect(session.eventSource.getSnapshot().entries).toEqual([])
  })

  it('malformed order and stale append generations fail visibly without publishing partial data', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.remote.sessionHistory.info.mockResolvedValue(ok(INFO))
    observe(mock, () => page([10]))
    await session.open()

    await push(mock, { type: 'append', generation: 'wrong-source-generation', entries: [event(11)] })
    await vi.waitFor(() => { expect(session.getSnapshot().openError?.code).toBe('gateway/internal') })
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([10])

    observe(mock, () => page([10, 9]))
    await session.open()
    expect(session.getSnapshot().openState).toBe('error')
    expect(session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([10])
  })
})
