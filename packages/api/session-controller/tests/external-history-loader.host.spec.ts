import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { ExternalHistoryController } from '../src/index.ts'
import type { ExternalHistorySource } from '../src/index.ts'
import type { ExternalHistoryPage } from '../src/external-history-types.ts'

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('composes an external display provider from a Loader profile and exposes its output through the real Gateway', async () => {
  const id = SessionId('loader-external-history')
  const address = { kind: 'session', sessionId: id } as const
  const current: ExternalHistoryPage = {
    generation: 'generation-1', hasMore: true, beforeCursor: 'older:opaque', resumeCursor: 'resume:opaque',
    entries: [
      { seq: 400, time: 1, type: 'plugin:fixture/message', ignorable: true, data: { role: 'assistant', text: 'Backend answer' } },
      { seq: 401, time: 2, type: 'plugin:fixture/tool', ignorable: true, data: { id: 'tool-1', status: 'running' } },
    ],
  }
  const older: ExternalHistoryPage = {
    generation: 'generation-1', hasMore: false,
    entries: [{ seq: 3, time: 0, type: 'plugin:fixture/message', ignorable: true, data: { role: 'user', text: 'Backend question' } }],
  }
  const activate = vi.fn<ExternalHistorySource['activate']>(async () => { throw new Error('Display reads must not activate inference') })
  const source: ExternalHistorySource = {
    header: { version: 3, id, createdAt: 0, cwd: '/external-fixture', isSeeded: false },
    page: vi.fn(async (request) => {
      expect(request).toEqual({ address, generation: 'generation-1', beforeCursor: 'older:opaque', limit: 20 })
      return older
    }),
    observe: async function* () {
      yield { type: 'replace', page: current }
      yield { type: 'patch', generation: 'generation-1', resumeCursor: 'resume:next', entries: [
        { seq: 401, time: 2, type: 'plugin:fixture/tool', ignorable: true, data: { id: 'tool-1', status: 'completed', result: 'Backend tool output' } },
      ] }
    },
    activate,
  }
  class FixtureProvider {
    static inject = ['sessionHistory']
    constructor(ctx: Context) {
      ctx.sessionHistory.register(ctx, {
        id: 'fixture-provider',
        resolve: async requested => requested.kind === 'session' && requested.sessionId === id ? source : undefined,
      })
    }
  }

  root = await mkdtemp(join(tmpdir(), 'dsh-external-history-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:registry',
    '- name: cordis:access',
    '- name: cordis:gateway',
    '- name: cordis:external-history',
    '- name: cordis:fixture-provider',
    '',
  ].join('\n'))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    registry: TypertRegistry,
    access: RemoteAccessService,
    gateway: TypertGatewayService,
    'external-history': ExternalHistoryController,
    'fixture-provider': FixtureProvider,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const info = await ctx.typertGateway.invoke({ peer, namespace: 'sessionHistory', method: 'info', args: { request: { address } } })
  const historyPage = await ctx.typertGateway.invoke({ peer, namespace: 'sessionHistory', method: 'page',
    args: { request: { address, generation: 'generation-1', beforeCursor: 'older:opaque', limit: 20 } } })
  const frames: unknown[] = []
  for await (const frame of await ctx.typertGateway.stream({ peer, namespace: 'sessionHistory', method: 'observe', args: { request: { address } } })) frames.push(frame)
  await expect(JSON.stringify({ info, page: historyPage, frames }, null, 2) + '\n')
    .toMatchFileSnapshot('./fixtures/external-history-display.expected.json')
  expect(activate).not.toHaveBeenCalled()
  expect(ctx.get('sessions')).toBeUndefined()
  expect(ctx.get('sessionPersistence')).toBeUndefined()
  expect(ctx.get('llm')).toBeUndefined()

  const provider = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-provider')
  if (provider === undefined) throw new Error('Loader did not retain the provider entry')
  await provider.fiber?.dispose()
  await expect(ctx.typertGateway.invoke({ peer, namespace: 'sessionHistory', method: 'info', args: { request: { address } } }))
    .rejects.toMatchObject({ code: 'session/external-history-unavailable' })
  expect(ctx.get('sessionHistory')).toBeDefined()
})
