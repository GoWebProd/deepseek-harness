import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const artifacts = {
  registry: 'packages/typert/registry/lib/client.js',
  gateway: 'packages/api/gateway/lib/client.js',
  remotes: 'packages/api/remotes/lib/client.js',
}
const built = Object.values(artifacts).every(path => existsSync(resolve(root, path)))

describe.skipIf(!built)('external history built Client namespace', () => {
  it('materializes sessionHistory from the bundled Remote assembly before the Session Client starts', async () => {
    const urls = Object.fromEntries(Object.entries(artifacts).map(([key, path]) => [key, pathToFileURL(resolve(root, path)).href]))
    const script = `
      import * as cordis from '@deepseek-ai/cordis'
      import * as zod from 'zod'
      const handoffs = new Map()
      globalThis.window = { __ModuleLoader__: { load: handoff => handoffs.set(handoff.id, handoff) } }
      const urls = ${JSON.stringify(urls)}
      for (const url of Object.values(urls)) await import(url)
      const instantiate = id => {
        const handoff = handoffs.get(id)
        if (!handoff) throw new Error('Missing built Client handoff: ' + id)
        return handoff.factory(specifier => {
          if (specifier === '@deepseek-ai/cordis') return cordis
          if (specifier === 'zod') return zod
          throw new Error('Unexpected Client external: ' + specifier)
        })
      }
      const ctx = new cordis.Context()
      const calls = []
      ctx.provide('connection', {
        interactions: 'none',
        registerGenerationSource() { return () => {} },
        start() { return { stop() {} } },
        rpc: {
          async call(channel, endpoint, payload) {
            calls.push({ channel, endpoint, payload })
            return { ok: true, value: { kind: 'native' } }
          },
          async *open() {},
        },
      })
      try {
        for (const id of ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-remotes']) {
          const plugin = instantiate(id)
          await ctx.plugin({ inject: plugin.inject, apply: plugin.apply })
        }
        const namespace = ctx.get('remote.sessionHistory')
        if (!namespace) throw new Error('Built api-remotes is missing remote.sessionHistory; rebuild and deploy its bundled contribution')
        const methods = ['info', 'page', 'observe'].filter(name => typeof namespace[name] === 'function')
        const result = await ctx.remote.sessionHistory.info({ address: { kind: 'session', sessionId: 'built-display-fixture' } })
        console.log(JSON.stringify({ methods, result, calls }))
      } finally {
        await ctx.fiber.dispose()
      }
    `
    const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir, encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
        done({ exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
      })
    })
    expect(result.exitCode, result.stderr).toBe(0)
    const output: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
    expect(output).toEqual({
      methods: ['info', 'page', 'observe'],
      result: { ok: true, value: { kind: 'native' } },
      calls: [{ channel: '/api', endpoint: 'sessionHistory/info', payload: { args: { request: { address: { kind: 'session', sessionId: 'built-display-fixture' } } } } }],
    })
  })
})
