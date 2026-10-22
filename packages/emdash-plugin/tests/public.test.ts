import type { RouteHandler } from 'emdash/plugin'
import type { ShardSnapshot } from '../src/snapshot'
import { describe, expect, it } from 'bun:test'
import { CALL_BUDGET } from '../src/budget'
import { PUBLIC_CACHE_CONTROL, publicRoutes } from '../src/routes/public'
import { createFakeContext, monitorNames, monitorsYaml } from './fake-context'

/** A route entry is a bare handler or a config with one; these routes are the config form. */
function handlerOf(name: string): RouteHandler {
  const entry = publicRoutes[name]
  if (!entry || typeof entry === 'function') {
    throw new Error(`route ${name} is not in config form`)
  }
  return entry.handler
}

const request = { url: 'https://example.com/', method: 'GET', headers: {} }

describe('the public route declarations', () => {
  it('are public, raw, GET-only and carry the standalone cache policy', () => {
    expect(Object.keys(publicRoutes).sort()).toEqual(['badge', 'badge-response-time', 'badge-uptime', 'status'])
    for (const entry of Object.values(publicRoutes)) {
      expect(entry).toMatchObject({ public: true, response: 'raw', methods: ['GET'], cacheControl: PUBLIC_CACHE_CONTROL })
    }
  })
})

describe('the public routes\' bridge calls', () => {
  // Many monitors across two shards: the cost must not grow with the monitor count.
  const names = monitorNames(200)
  const snapshot = (shard: number, slugs: string[]): ShardSnapshot => ({
    version: 2,
    shard,
    updatedAt: '2026-10-22T00:00:00.000Z',
    deliveries: [],
    monitors: slugs.map(slug => ({ slug, result: { slug, status: 'up', code: 200, responseTime: 10, checkedAt: '2026-10-22T00:00:00.000Z' }, days: [] })),
  })

  const invocations: Array<[string, Record<string, string>]> = [
    ['status', {}],
    ['status', { slug: names[0] as string }],
    ['status', { slug: 'unknown' }],
    ['badge', {}],
    ['badge', { slug: names[1] as string }],
    ['badge-uptime', { slug: names[2] as string, period: 'week' }],
    ['badge-response-time', { slug: names[3] as string }],
  ]

  it('stay at two or fewer per route, with no per-monitor call and no log call', async () => {
    const fake = createFakeContext({ config: monitorsYaml(names) })
    await fake.ctx.kv.set('snapshot:0', snapshot(0, names.slice(0, 100)))
    await fake.ctx.kv.set('snapshot:1', snapshot(1, names.slice(100)))

    for (const [name, input] of invocations) {
      fake.bridgeCalls.length = 0
      await handlerOf(name)({ input, request }, fake.ctx)
      expect(fake.bridgeCalls.length, `${name} ${JSON.stringify(input)}`).toBeLessThanOrEqual(2)
      expect(fake.bridgeCalls.length).toBeLessThan(CALL_BUDGET)
      expect(fake.bridgeCalls.some(call => call.startsWith('log.'))).toBe(false)
      expect([...new Set(fake.bridgeCalls)].sort()).toEqual(['kv.list', 'settings.list'])
    }
  })

  it('need one call for an absent or invalid configuration, and never throw', async () => {
    for (const config of ['', 'name: Test\nsites: [oops']) {
      const fake = createFakeContext({ config })
      for (const [name, input] of invocations) {
        fake.bridgeCalls.length = 0
        const response = await handlerOf(name)({ input, request }, fake.ctx) as { status: number }
        expect([200, 404]).toContain(response.status)
        expect(fake.bridgeCalls).toEqual(['settings.list'])
      }
    }
  })
})
