// @vitest-environment jsdom
/** External history traverses the production Session, scope, and Conversation services. */
import { expect } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ExternalHistoryInfo } from '../src/external-history-types.ts'
import { sessionWorld } from './remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure([
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat',
]) })
const SID = 'assembled-external' as SessionId

it('opens an external source through the API Client plugin and publishes a scoped Chat view', async ({ mock, start }) => {
  mock.load(sessionWorld)
  mock.remote.session.list.mockResolvedValue(ok({ items: [
    { sessionId: SID, updatedAt: 1, running: false, blank: false, agentAvailable: true },
  ] }))
  const source: ExternalHistoryInfo = { kind: 'external', sourceId: 'fixture', capabilities: { nativeJournal: false },
    header: { version: SESSION_FORMAT_VERSION, id: SID, createdAt: 1, isSeeded: false } }
  mock.remote.sessionHistory.info.mockResolvedValue(ok(source))
  mock.stream('sessionHistory/observe', (_request, stream) => {
    stream.push({ type: 'replace', page: { generation: 'fixture', hasMore: false, entries: [
      { seq: 100, time: 1, type: 'plugin:fixture/display', ignorable: true, data: { text: 'External message' } },
    ] } })
  })
  const client = await start()
  await client.ctx.sessions.refresh()
  client.ctx.uiConversation.events.register({
    kind: 'fixture-display', target: 'chat',
    match: { 'plugin:fixture/display': () => ({ id: 'message', role: 'start' }) },
    start: () => null, update: context => context.state,
    buildViewNode: context => ({ key: context.key, id: context.id, target: 'chat', kind: 'user', anchorSeq: 100,
      navigation: { kind: 'message', position: 100 },
      location: { kind: 'session' }, groupTree: 'exchange', visibility: 'visible', data: {
        kind: 'user', messageId: 'external:fixture', seq: 100, time: 1,
        content: [{ type: 'text', text: 'External message' }], source: { kind: 'user' },
      } }),
  })
  using reference = client.ctx.sessions.retain(SID, { source: 'mainView' })
  const binding = await reference.ready
  expect(client.ctx.uiSession.bindingSource(reference).getSnapshot().key).toBe(SID)
  expect(binding.session.getSnapshot()).toMatchObject({ openState: 'open', historySource: source })
  expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
  const view = client.ctx.uiConversation.binding(binding).target('chat')
  const stop = view.subscribe(() => {})
  try {
    expect(view.getSnapshot()?.order).toHaveLength(1)
    expect(view.getSnapshot()?.timeline.turnOrder).toEqual([])
    await expect(JSON.stringify(view.getSnapshot()?.navigation.items(), null, 2) + '\n')
      .toMatchFileSnapshot('./fixtures/external-message-navigation.expected.json')
  } finally { stop() }
  expect(mock.log.requests('session/follow')).toEqual([])
}, 60_000)
