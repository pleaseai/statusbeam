import type { PollSnapshot, WebhookSnapshot } from '../src/snapshot'
import type { Host, Internet } from './host-harness'
import { describe, expect, it, spyOn } from 'bun:test'
import { CHECK_TASK } from '../src/schedule'
import { mergeSnapshots, POLL_SNAPSHOT_KEY, summariesFromSnapshot } from '../src/snapshot'
import { HOST, newHost } from './host-harness'

/**
 * The webhook routes through EmDash's production route boundary
 * (`dispatchPluginApiRequest`: host-side method check, text body, raw response)
 * on the real runtime, so storage, settings and secrets are the host's own.
 */

const SECRET = 'sekret-token'

const CONFIG = [
  'name: Test',
  'sites:',
  '  - name: web',
  '    check: statuspage',
  `    url: https://${HOST}/status/web`,
  '  - name: errors',
  '    check: sentry',
  '    url: https://sentry.example.com/',
  '  - name: plain',
  '    url: https://plain.example.com/',
].join('\n')

const DOWN = { page: { status_indicator: 'major' } }
const UP = { page: { status_indicator: 'none' } }

let tick = 1
/** Deterministic time: `at(n)` is n seconds past 10:00 UTC on 2026-10-22, and `now` follows the last one set. */
const at = (second: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, second))
const now = () => at(tick)

const ok: Internet = () => new Response('ok', { status: 200 })

async function newWebhookHost(options: { secret?: string | null, urls?: string, config?: string, internet?: Internet } = {}): Promise<Host> {
  tick = 1
  const host = await newHost(options.internet ?? ok, { now })
  await host.setConfig(options.config ?? CONFIG)
  const secrets: Record<string, string> = {}
  if (options.secret !== null) {
    secrets.webhookSecret = options.secret ?? SECRET
  }
  if (options.urls) {
    secrets.webhookUrls = options.urls
  }
  if (Object.keys(secrets).length > 0) {
    await host.setSecrets(secrets)
  }
  return host
}

interface Call {
  provider?: 'statuspage' | 'sentry'
  method?: string
  /** `null` leaves the `slug` query parameter out entirely. */
  slug?: string | null
  token?: string | null
  body?: unknown
  rawBody?: string
  second?: number
}

async function post(host: Host, call: Call = {}): Promise<{ status: number, text: string, headers: Headers }> {
  tick = call.second ?? 1
  const query: Record<string, string> = {}
  if (call.slug !== null) {
    query.slug = call.slug ?? 'web'
  }
  if (call.token !== null) {
    query.token = call.token ?? SECRET
  }
  const method = call.method ?? 'POST'
  const response = await host.dispatch(`webhooks/${call.provider ?? 'statuspage'}`, {
    method,
    query,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: call.rawBody ?? JSON.stringify(call.body ?? DOWN) }),
  })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

/** Everything the plugin stored besides its settings: kv keys and bucket rows. */
async function stored(host: Host): Promise<string> {
  return JSON.stringify([await host.kvKeys(), await host.bucketRows()])
}

describe('the webhook routes\' declarations', () => {
  it('are one public POST raw route per provider, and answer other methods with 405 before anything else', async () => {
    const host = await newWebhookHost()
    for (const provider of ['statuspage', 'sentry'] as const) {
      for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
        const response = await post(host, { provider, method })
        expect(response.status, `${provider} ${method}`).toBe(405)
        expect(response.headers.get('allow')).toBe('POST')
      }
    }
    // Even with no secret and no token at all: the method comes first.
    const open = await newWebhookHost({ secret: null })
    expect((await post(open, { method: 'GET', token: null })).status).toBe(405)
    expect(await stored(open)).toBe(await stored(await newWebhookHost()))
    // Only the two provider routes exist.
    expect((await host.dispatch('webhooks/other', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('webhook authentication fails closed', () => {
  it('rejects every request while no secret is set, whatever token it carries, touching nothing', async () => {
    const unset = await newWebhookHost({ secret: null })
    for (const token of [SECRET, '', null]) {
      expect(await post(unset, { token })).toMatchObject({ status: 401, text: 'Unauthorized' })
    }
    expect(await stored(unset)).toBe(JSON.stringify([[], {}]))

    // A secret cleared to the empty string is unset too.
    const cleared = await newWebhookHost()
    await cleared.setSecrets({ webhookSecret: '' })
    for (const token of [SECRET, '', null]) {
      expect(await post(cleared, { token })).toMatchObject({ status: 401, text: 'Unauthorized' })
    }
    expect(await stored(cleared)).toBe(JSON.stringify([[], {}]))
  })

  it('rejects a mismatched, empty, absent, wrong-length or non-ASCII token before grading or storage, leaving the status unchanged', async () => {
    const host = await newWebhookHost()
    expect((await post(host)).status).toBe(200)
    const before = await stored(host)

    const tokens = [
      'wrong',
      SECRET.slice(0, -1),
      `${SECRET}x`,
      '',
      null,
      // Same UTF-16 length as the secret, with non-ASCII characters.
      `${SECRET.slice(0, -2)}éé`,
      'é'.repeat(SECRET.length),
      // A surrogate pair counts two units; the length differs by one.
      `${SECRET.slice(0, -1)}😀`,
      '😀'.repeat(SECRET.length),
      '\u0000',
    ]
    for (const token of tokens) {
      const response = await post(host, { token, body: UP, rawBody: 'not json at all' })
      expect(response, JSON.stringify(token)).toMatchObject({ status: 401, text: 'Unauthorized' })
      expect(response.text).not.toContain(SECRET)
    }

    expect(await stored(host)).toBe(before)
    expect((await host.readKv<WebhookSnapshot>('snapshot:webhook:web'))?.monitor.result?.status).toBe('down')
  })
})

describe('webhook routing after a valid token', () => {
  it('returns 404 and changes nothing for an unknown slug, a missing slug, and a check kind that does not match the provider', async () => {
    const host = await newWebhookHost()
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
      expect(await post(host, call), JSON.stringify(call)).toMatchObject({ status: 404, text: 'Unknown site' })
    }
    expect(await stored(host)).toBe(JSON.stringify([[], {}]))
  })

  it('returns 404 for a monitor of a configuration the plugin rules reject, as the scheduled run refuses it too', async () => {
    // Core accepts duplicate slugs; the plugin does not, so no route may act on this configuration.
    const duplicate = `${CONFIG}\n  - name: web\n    check: statuspage\n    url: https://other.example.com/`
    const host = await newWebhookHost({ config: duplicate })
    expect(await post(host, { body: DOWN })).toMatchObject({ status: 404, text: 'Unknown site' })
    expect(await stored(host)).toBe(JSON.stringify([[], {}]))
  })

  it('answers invalid JSON and a wrong-shaped payload with 400, and an event for another component with 204, writing nothing', async () => {
    const host = await newWebhookHost()
    expect((await post(host, { rawBody: '{oops' })).status).toBe(400)
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await post(host, { body: { page: 7 } })).toMatchObject({ status: 400, text: 'Invalid payload' })
      // The caller gets the bare 400; the Zod reason goes to the log, as in the standalone Worker.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^webhook: payload failed validation for slug "web": .*page/s)
    }
    finally {
      warn.mockRestore()
    }
    expect((await post(host, { body: {} })).status).toBe(204)
    expect(await stored(host)).toBe(JSON.stringify([[], {}]))

    // A component site receives every component's events; one about another component is ignored.
    const component = await newWebhookHost({ config: CONFIG.replace(`    url: https://${HOST}/status/web`, `    url: https://${HOST}/status/web\n    component: API`) })
    const other = { component: { id: 'db1', name: 'Database', status: 'major_outage' } }
    expect(await post(component, { body: other })).toMatchObject({ status: 204, text: '' })
    expect(await stored(component)).toBe(JSON.stringify([[], {}]))
    // The same event about the configured component is graded, so the 204 above is the component filter.
    expect((await post(component, { body: { component: { id: 'api1', name: 'API', status: 'major_outage' } } })).status).toBe(200)
  })
})

describe('an accepted webhook event', () => {
  it('updates the snapshot and today\'s bucket like a polled result, in webhook-owned records', async () => {
    const host = await newWebhookHost()

    expect(await post(host, { body: UP, second: 1 })).toMatchObject({ status: 200, text: 'OK' })
    expect(await post(host, { body: DOWN, second: 2 })).toMatchObject({ status: 200, text: 'OK' })

    expect(await host.bucketRows()).toEqual({ 'web:2026-10-22:webhook': { slug: 'web', date: '2026-10-22', up: 1, degraded: 0, down: 1, total: 2 } })
    expect(await host.kvKeys()).toEqual(['snapshot:webhook:web'])
    const snapshot = await host.readKv<WebhookSnapshot>('snapshot:webhook:web')
    expect(snapshot?.monitor.result).toMatchObject({ slug: 'web', status: 'down', code: 200, checkedAt: '2026-10-22T10:00:02.000Z' })

    const sites = [{ name: 'web', slug: 'web', url: 'https://status.example.com/', check: 'statuspage' } as never]
    const [summary] = summariesFromSnapshot(mergeSnapshots([{ key: 'snapshot:webhook:web', value: snapshot }]), sites, at(3))
    expect(summary).toMatchObject({ slug: 'web', status: 'down', uptimeDay: '50.00%' })
    expect(summary?.history.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
  })

  it('accepts a Sentry event on its own route and shows a webhook-only Sentry monitor from its webhook records alone', async () => {
    const host = await newWebhookHost()
    expect((await post(host, { provider: 'sentry', slug: 'errors', body: { action: 'created', data: { issue: { status: 'unresolved' } } } })).status).toBe(200)

    const snapshot = await host.readKv<WebhookSnapshot>('snapshot:webhook:errors')
    const sites = [{ name: 'errors', slug: 'errors', url: 'https://sentry.example.com/', check: 'sentry' } as never]
    const [summary] = summariesFromSnapshot(mergeSnapshots([{ key: 'snapshot:webhook:errors', value: snapshot }]), sites, at(2))
    expect(summary?.status).toBe('down')
    expect(summary?.history.at(-1)).toMatchObject({ date: '2026-10-22', status: 'down', uptime: 0 })
  })

  it('reads a webhook-only monitor as not checked yet until its first event, which notifies nobody', async () => {
    const posts: string[] = []
    const host = await newWebhookHost({
      urls: `https://${HOST}/hook/HOOKSECRET`,
      internet: (target, init) => {
        if (init?.method === 'POST') {
          posts.push(target)
        }
        return new Response('ok', { status: 200 })
      },
    })
    const sites = [{ name: 'errors', slug: 'errors', url: 'https://sentry.example.com/', check: 'sentry' } as never]
    const [before] = summariesFromSnapshot(mergeSnapshots([]), sites, at(1))
    expect(before).toMatchObject({ slug: 'errors', status: 'down', pending: true })

    const created = { action: 'created', data: { issue: { status: 'unresolved' } } }
    expect((await post(host, { provider: 'sentry', slug: 'errors', body: created, second: 2 })).status).toBe(200)

    expect(posts).toEqual([])
    const snapshot = await host.readKv<WebhookSnapshot>('snapshot:webhook:errors')
    expect(snapshot?.deliveries).toEqual([])
    const [after] = summariesFromSnapshot(mergeSnapshots([{ key: 'snapshot:webhook:errors', value: snapshot }]), sites, at(3))
    expect(after).toMatchObject({ slug: 'errors', status: 'down' })
    expect(after).not.toHaveProperty('pending')
  })

  it('tells each destination once about a status change, and stores no destination URL', async () => {
    for (const count of [0, 1, 3, 6]) {
      const urls = Array.from({ length: count }, (_, i) => `https://${HOST}/hook${i}/secret-${i}`)
      const posts: string[] = []
      const host = await newWebhookHost({
        urls: urls.join('\n'),
        internet: (target, init) => {
          if (init?.method === 'POST') {
            posts.push(target)
          }
          return new Response('ok', { status: 200 })
        },
      })
      await post(host, { body: UP, second: 1 })
      expect(posts).toEqual([])

      expect((await post(host, { body: DOWN, second: 2 })).status).toBe(200)
      expect(posts.sort(), `${count} destinations`).toEqual([...urls].sort())
      const snapshot = await host.readKv<WebhookSnapshot>('snapshot:webhook:web')
      expect(snapshot?.deliveries.length).toBe(count)
      expect(JSON.stringify(snapshot)).not.toContain('secret-')

      // The same status again is no change.
      posts.length = 0
      expect((await post(host, { body: DOWN, second: 3 })).status).toBe(200)
      expect(posts).toEqual([])
    }
  })

  it('returns no secret value in any response', async () => {
    const host = await newWebhookHost({ urls: `https://${HOST}/hook/HOOKSECRET` })
    const texts: string[] = []
    for (const call of [{}, { token: 'x' }, { token: null }, { slug: 'nope' }, { rawBody: '{oops' }, { method: 'GET' }, { body: { page: 7 } }, { body: {} }, { provider: 'sentry' as const }]) {
      const response = await post(host, call)
      texts.push(response.text, [...response.headers].join(';'))
    }
    for (const text of texts) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('HOOKSECRET')
    }
  })
})

describe('a webhook racing a check run', () => {
  it('loses no bucket count and neither writer\'s latest result when an event lands between the check\'s reads and writes', async () => {
    let indicator = 'none'
    let raced = false
    let host!: Host
    const internet: Internet = async (target, init) => {
      if (init?.method === 'POST') {
        // The delivery happens after the run read its buckets and snapshots, before it writes them.
        if (!raced) {
          raced = true
          expect((await post(host, { body: DOWN, second: 5 })).status).toBe(200)
        }
        return new Response('ok', { status: 200 })
      }
      return Response.json({ status: { indicator } })
    }
    host = await newWebhookHost({ urls: `https://${HOST}/hook/HOOKSECRET`, internet })

    tick = 1
    expect(await host.cron(CHECK_TASK)).toBe(true)
    expect(raced).toBe(false)

    // Second run: the poll result changes to down, so it delivers, and the webhook lands during that delivery.
    indicator = 'major'
    tick = 2
    expect(await host.cron(CHECK_TASK)).toBe(true)
    expect(raced).toBe(true)

    const rows = await host.bucketRows()
    expect(rows['web:2026-10-22']).toMatchObject({ up: 1, down: 1, total: 2 })
    expect(rows['web:2026-10-22:webhook']).toMatchObject({ up: 0, down: 1, total: 1 })

    const poll = await host.readKv<PollSnapshot>(POLL_SNAPSHOT_KEY)
    const hook = await host.readKv<WebhookSnapshot>('snapshot:webhook:web')
    expect(poll?.monitors.find(m => m.slug === 'web')?.result).toMatchObject({ status: 'down', checkedAt: '2026-10-22T10:00:02.000Z' })
    expect(hook?.monitor.result).toMatchObject({ status: 'down', checkedAt: '2026-10-22T10:00:05.000Z' })
    const merged = mergeSnapshots([{ key: POLL_SNAPSHOT_KEY, value: poll }, { key: 'snapshot:webhook:web', value: hook }])
    expect(merged.monitors.get('web')?.totals['2026-10-22']).toBe(3)
    expect(merged.monitors.get('web')?.days.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 1 / 3 })

    // The next run carries over only its own counts: nothing is counted twice.
    indicator = 'none'
    tick = 9
    await host.cron(CHECK_TASK)
    expect((await host.bucketRows())['web:2026-10-22']).toMatchObject({ up: 2, down: 1, total: 3 })
    const after = mergeSnapshots([
      { key: POLL_SNAPSHOT_KEY, value: await host.readKv<PollSnapshot>(POLL_SNAPSHOT_KEY) },
      { key: 'snapshot:webhook:web', value: await host.readKv<WebhookSnapshot>('snapshot:webhook:web') },
    ])
    expect(after.monitors.get('web')?.totals['2026-10-22']).toBe(4)
    expect(after.monitors.get('web')?.days.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 2 / 4 })
    expect(after.results.get('web')?.status).toBe('up')
  })
})
