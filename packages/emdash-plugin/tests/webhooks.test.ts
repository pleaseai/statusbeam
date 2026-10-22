import type { PluginContext, PluginResponse } from 'emdash/plugin'
import type { DayBucket } from '../src/buckets'
import type { WebhookSnapshot } from '../src/snapshot'
import { describe, expect, it, spyOn } from 'bun:test'
import { handleWebhook, WEBHOOK_MAX_DESTINATIONS, webhookRoutes } from '../src/routes/webhooks'
import { runShard } from '../src/run'
import { readSnapshot, summariesFromSnapshot } from '../src/snapshot'
import { createFakeContext } from './fake-context'

const SECRET = 'sekret-token'

const CONFIG = [
  'name: Test',
  'sites:',
  '  - name: web',
  '    check: statuspage',
  '    url: https://status.example.com/',
  '  - name: errors',
  '    check: sentry',
  '    url: https://sentry.example.com/',
  '  - name: plain',
  '    url: https://plain.example.com/',
].join('\n')

const DOWN = { page: { status_indicator: 'major' } }
const UP = { page: { status_indicator: 'none' } }

function at(second: number): () => Date {
  return () => new Date(Date.UTC(2026, 9, 22, 10, 0, second))
}

function newContext(settings: Record<string, unknown> = { webhookSecret: SECRET }, fetch?: (url: string) => Promise<Response>) {
  return createFakeContext({ config: CONFIG, settings, ...(fetch ? { fetch } : {}) })
}

interface Call {
  provider?: 'statuspage' | 'sentry'
  method?: string
  /** `null` leaves the `slug` query parameter out entirely. */
  slug?: string | null
  token?: string | null
  body?: unknown
  rawBody?: string
  now?: () => Date
}

async function post(ctx: PluginContext, call: Call = {}): Promise<{ status: number, text: string | null }> {
  const query = new URLSearchParams()
  if (call.slug !== null) {
    query.set('slug', call.slug ?? 'web')
  }
  if (call.token !== null) {
    query.set('token', call.token ?? SECRET)
  }
  const response: PluginResponse = await handleWebhook(
    call.provider ?? 'statuspage',
    {
      input: call.rawBody ?? JSON.stringify(call.body ?? DOWN),
      request: { url: `https://site.example.com/_emdash/api/plugins/statusbeam/webhooks/x?${query}`, method: call.method ?? 'POST', headers: {} },
    },
    ctx,
    { now: call.now ?? at(1) },
  )
  return { status: response.status, text: response.body?.kind === 'text' ? response.body.value : null }
}

describe('webhook routes', () => {
  it('declares one public POST raw route per provider that takes the body as text', () => {
    expect(Object.keys(webhookRoutes).sort()).toEqual(['webhooks/sentry', 'webhooks/statuspage'])
    for (const route of Object.values(webhookRoutes)) {
      expect(route).toMatchObject({ public: true, methods: ['POST'], response: 'raw', request: { body: 'text' } })
    }
  })
})

describe('webhook authentication fails closed', () => {
  it('rejects every request while no secret is set, whatever token it carries, touching nothing but settings', async () => {
    for (const settings of [{}, { webhookSecret: '' }]) {
      for (const token of [SECRET, '', null]) {
        const fake = newContext(settings)
        expect(await post(fake.ctx, { token })).toEqual({ status: 401, text: 'Unauthorized' })
        expect(fake.bridgeCalls).toEqual(['settings.list'])
        expect(fake.rows.size + fake.kv.size).toBe(0)
      }
    }
  })

  it('rejects a mismatched, empty or absent token before grading or storage, leaving the status unchanged', async () => {
    const fake = newContext()
    expect((await post(fake.ctx)).status).toBe(200)
    const before = JSON.stringify([...fake.kv, ...fake.rows])
    fake.bridgeCalls.length = 0

    for (const token of ['wrong', SECRET.slice(0, -1), `${SECRET}x`, '', null]) {
      expect(await post(fake.ctx, { token, body: UP, rawBody: 'not json at all' })).toEqual({ status: 401, text: 'Unauthorized' })
    }

    expect(fake.bridgeCalls).toEqual(Array.from({ length: 5 }).fill('settings.list') as string[])
    expect(JSON.stringify([...fake.kv, ...fake.rows])).toBe(before)
    expect((await readSnapshot(fake.ctx)).results.get('web')?.status).toBe('down')
  })

  it('answers non-POST requests with 405 before reading anything', async () => {
    const fake = newContext()
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
      expect((await post(fake.ctx, { method })).status).toBe(405)
    }
    expect(fake.bridgeCalls).toEqual([])
  })
})

describe('webhook routing after a valid token', () => {
  it('returns 404 and changes nothing for an unknown slug, a missing slug, and a check kind that does not match the provider', async () => {
    const fake = newContext()
    const cases: Call[] = [
      { slug: 'nope' },
      { slug: '' },
      { slug: null },
      { provider: 'sentry', slug: 'web' },
      { provider: 'statuspage', slug: 'errors', body: { action: 'created' } },
      { provider: 'statuspage', slug: 'plain' },
      { provider: 'sentry', slug: 'plain' },
    ]
    for (const call of cases) {
      expect(await post(fake.ctx, call)).toEqual({ status: 404, text: 'Unknown site' })
    }
    expect(fake.bridgeCalls).toEqual(Array.from({ length: cases.length }).fill('settings.list') as string[])
    expect(fake.rows.size + fake.kv.size).toBe(0)
  })

  it('returns 404 for a monitor of a configuration the plugin rules reject, as the scheduled run refuses it too', async () => {
    // Core accepts duplicate slugs; the plugin does not, so no route may act on this configuration.
    const duplicate = `${CONFIG}\n  - name: web\n    check: statuspage\n    url: https://other.example.com/`
    const fake = createFakeContext({ config: duplicate, settings: { webhookSecret: SECRET } })
    expect(await post(fake.ctx, { body: DOWN })).toEqual({ status: 404, text: 'Unknown site' })
    expect(fake.bridgeCalls).toEqual(['settings.list'])
    expect(fake.rows.size + fake.kv.size).toBe(0)
  })

  it('answers invalid JSON and a wrong-shaped payload with 400, and an event for another component with 204, writing nothing', async () => {
    const fake = newContext()
    expect((await post(fake.ctx, { rawBody: '{oops' })).status).toBe(400)
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await post(fake.ctx, { body: { page: 7 } })).toEqual({ status: 400, text: 'Invalid payload' })
      // The caller gets the bare 400; the Zod reason goes to the log, as in the standalone Worker.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^webhook: payload failed validation for slug "web": .*page/s)
    }
    finally {
      warn.mockRestore()
    }
    expect((await post(fake.ctx, { body: {} })).status).toBe(204)
    expect(fake.rows.size + fake.kv.size).toBe(0)

    // A component site receives every component's events; one about another component is ignored.
    const component = createFakeContext({ config: CONFIG.replace('    url: https://status.example.com/', '    url: https://status.example.com/\n    component: API'), settings: { webhookSecret: SECRET } })
    const other = { component: { id: 'db1', name: 'Database', status: 'major_outage' } }
    expect(await post(component.ctx, { body: other })).toEqual({ status: 204, text: null })
    expect(component.rows.size + component.kv.size).toBe(0)
    // The same event about the configured component is graded, so the 204 above is the component filter.
    expect((await post(component.ctx, { body: { component: { id: 'api1', name: 'API', status: 'major_outage' } } })).status).toBe(200)
  })
})

describe('an accepted webhook event', () => {
  it('updates the snapshot and today\'s bucket like a polled result, in webhook-owned records', async () => {
    const fake = newContext()

    expect(await post(fake.ctx, { body: UP, now: at(1) })).toEqual({ status: 200, text: 'OK' })
    expect(await post(fake.ctx, { body: DOWN, now: at(2) })).toEqual({ status: 200, text: 'OK' })

    expect([...fake.rows.keys()]).toEqual(['web:2026-10-22:webhook'])
    expect(fake.rows.get('web:2026-10-22:webhook')).toEqual({ slug: 'web', date: '2026-10-22', up: 1, degraded: 0, down: 1, total: 2 })
    expect([...fake.kv.keys()]).toEqual(['snapshot:webhook:web'])
    const stored = fake.kv.get('snapshot:webhook:web') as WebhookSnapshot
    expect(stored.monitor.result).toMatchObject({ slug: 'web', status: 'down', code: 200, checkedAt: '2026-10-22T10:00:02.000Z' })

    const merged = await readSnapshot(fake.ctx)
    const [summary] = summariesFromSnapshot(merged, [{ name: 'web', slug: 'web', url: 'https://status.example.com/', check: 'statuspage' } as never], at(3)())
    expect(summary).toMatchObject({ slug: 'web', status: 'down', uptimeDay: '50.00%' })
    expect(summary?.history.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
  })

  it('shows a webhook-only Sentry monitor in the summaries from its webhook records alone', async () => {
    const fake = newContext()
    await post(fake.ctx, { provider: 'sentry', slug: 'errors', body: { action: 'created', data: { issue: { status: 'unresolved' } } } })

    const merged = await readSnapshot(fake.ctx)
    const sites = [{ name: 'errors', slug: 'errors', url: 'https://sentry.example.com/', check: 'sentry' } as never]
    const [summary] = summariesFromSnapshot(merged, sites, at(2)())
    expect(summary?.status).toBe('down')
    expect(summary?.history.at(-1)).toMatchObject({ date: '2026-10-22', status: 'down', uptime: 0 })
  })

  it('reads a webhook-only monitor as not checked yet until its first event, which notifies nobody', async () => {
    const fake = newContext({ webhookSecret: SECRET, webhookUrls: 'https://hook.example.com/secret' })
    const sites = [{ name: 'errors', slug: 'errors', url: 'https://sentry.example.com/', check: 'sentry' } as never]
    const [before] = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, at(1)())
    expect(before).toMatchObject({ slug: 'errors', status: 'down', pending: true })

    const created = { action: 'created', data: { issue: { status: 'unresolved' } } }
    expect((await post(fake.ctx, { provider: 'sentry', slug: 'errors', body: created, now: at(2) })).status).toBe(200)

    expect(fake.bridgeCalls.filter(call => call === 'http.fetch')).toEqual([])
    expect((fake.kv.get('snapshot:webhook:errors') as WebhookSnapshot).deliveries).toEqual([])
    const [after] = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, at(3)())
    expect(after).toMatchObject({ slug: 'errors', status: 'down' })
    expect(after).not.toHaveProperty('pending')
  })
})

describe('a webhook racing a cron run', () => {
  it('loses no bucket count and neither writer\'s latest result when an event lands between the shard\'s reads and writes', async () => {
    const fake = newContext({ webhookSecret: SECRET }, async () => Response.json({ status: { indicator: 'none' } }))
    const base = fake.ctx
    // The webhook runs right after the shard has read its buckets and snapshots, so the shard writes from stale reads.
    const shardCtx = {
      ...base,
      storage: {
        buckets: {
          ...base.storage.buckets,
          getMany: async (ids: string[]) => {
            const rows = await (base.storage.buckets as never as { getMany: (ids: string[]) => Promise<Map<string, DayBucket>> }).getMany(ids)
            expect((await post(base, { body: DOWN, now: at(5) })).status).toBe(200)
            return rows
          },
        },
      },
    } as unknown as PluginContext

    const run = await runShard(shardCtx, 0, { now: at(1) })

    expect(run.probed).toBe(2)
    const poll = fake.rows.get('web:2026-10-22')
    const hook = fake.rows.get('web:2026-10-22:webhook')
    expect(poll).toMatchObject({ up: 1, down: 0, total: 1 })
    expect(hook).toMatchObject({ up: 0, down: 1, total: 1 })

    const merged = await readSnapshot(fake.ctx)
    expect(merged.polled.get('web')?.result).toMatchObject({ status: 'up', checkedAt: '2026-10-22T10:00:01.000Z' })
    expect(merged.pushed.get('web')?.result).toMatchObject({ status: 'down', checkedAt: '2026-10-22T10:00:05.000Z' })
    expect(merged.results.get('web')?.status).toBe('down')
    const today = merged.monitors.get('web')?.days.at(-1)
    expect(today).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
    expect(merged.monitors.get('web')?.totals?.['2026-10-22']).toBe((poll?.total ?? 0) + (hook?.total ?? 0))

    // The next shard run still carries over only its own counts: nothing is counted twice.
    await runShard(base, 0, { now: at(9) })
    expect(fake.rows.get('web:2026-10-22')).toMatchObject({ up: 2, total: 2 })
    const after = await readSnapshot(fake.ctx)
    expect(after.monitors.get('web')?.days.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 2 / 3 })
    expect(after.results.get('web')?.status).toBe('up')
  })
})

describe('a webhook stays within the call budget', () => {
  function destinations(count: number): string {
    return Array.from({ length: count }, (_, i) => `https://hook${i}.example.com/secret-${i}`).join('\n')
  }

  it('makes at most 10 bridge calls for up to 5 destinations and tells each of them once about a change', async () => {
    for (let count = 0; count <= WEBHOOK_MAX_DESTINATIONS; count++) {
      const fake = newContext({ webhookSecret: SECRET, webhookUrls: destinations(count) })
      await post(fake.ctx, { body: UP, now: at(1) })
      fake.bridgeCalls.length = 0

      expect((await post(fake.ctx, { body: DOWN, now: at(2) })).status).toBe(200)

      expect(fake.bridgeCalls.length).toBe(5 + count)
      expect(fake.bridgeCalls.length).toBeLessThanOrEqual(10)
      expect(fake.bridgeCalls.filter(call => call === 'http.fetch').length).toBe(count)
      expect(fake.bridgeCalls.filter(call => call.startsWith('log.'))).toEqual([])
      const stored = fake.kv.get('snapshot:webhook:web') as WebhookSnapshot
      expect(stored.deliveries.length).toBe(count)
      expect(stored.deliverySkipped).toBeUndefined()
      expect(JSON.stringify(stored)).not.toContain('secret-')
    }
  })

  it('records a change without delivering it when the destinations exceed the budget, and says so', async () => {
    const fake = newContext({ webhookSecret: SECRET, webhookUrls: destinations(WEBHOOK_MAX_DESTINATIONS + 1) })
    await post(fake.ctx, { body: UP, now: at(1) })
    fake.bridgeCalls.length = 0

    expect((await post(fake.ctx, { body: DOWN, now: at(2) })).status).toBe(200)

    expect(fake.bridgeCalls).toEqual(['settings.list', 'storage.getMany', 'kv.list', 'storage.putMany', 'kv.set'])
    const stored = fake.kv.get('snapshot:webhook:web') as WebhookSnapshot
    expect(stored).toMatchObject({ deliveries: [], deliverySkipped: 'capacity' })
    expect(stored.monitor.result?.status).toBe('down')
  })
})
