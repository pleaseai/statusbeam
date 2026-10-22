import type { Env } from './env'
import { describe, expect, it } from 'bun:test'
import { handleWebhook } from './webhook'

/**
 * A minimal in-memory {@link Env} + {@link ExecutionContext} for driving the
 * Sentry provider path through {@link handleWebhook} under bun:test (no
 * miniflare). Mirrors the Statuspage handler test's harness; the config holds a
 * webhook-only `check: sentry` site plus an `http` site (to exercise the
 * provider/check-kind mismatch → 404).
 */
function makeEnv(secret: string | undefined) {
  const kv = new Map<string, string>([
    [
      'config',
      `name: Test
sites:
  - name: API
    url: https://api.example.com
    check: sentry
  - name: Website
    url: https://example.com
    check: http
theme:
  darkMode: true
`,
    ],
  ])
  const inserted: unknown[][] = []
  const env = {
    WEBHOOK_SECRET: secret,
    STATUS_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v)
      },
    },
    DB: {
      batch: async (stmts: unknown[]) => stmts,
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO checks')) {
            inserted.push(args)
          }
          return { all: async () => ({ results: [] }) }
        },
      }),
    },
  } as unknown as Env
  const waited: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p)
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { env, ctx, kv, inserted, waited }
}

/** A Sentry issue-alert webhook body: an uptime issue opened (monitor failing). */
const created = {
  action: 'created',
  data: { issue: { id: '1', status: 'unresolved', title: 'Uptime check failed for api.example.com' } },
}

/** A Sentry resolved webhook body: the uptime issue recovered. */
const resolved = {
  action: 'resolved',
  data: { issue: { id: '1', status: 'resolved', title: 'Uptime check failed for api.example.com' } },
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('handleWebhook — sentry auth & routing', () => {
  it('401s when WEBHOOK_SECRET is unset (fails closed)', async () => {
    const { env, ctx } = makeEnv(undefined)
    const res = await handleWebhook(post('/webhooks/sentry/api?token=anything', created), env, ctx)
    expect(res.status).toBe(401)
  })

  it('401s on a wrong token', async () => {
    const { env, ctx } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/api?token=WRONG', created), env, ctx)
    expect(res.status).toBe(401)
  })

  it('405s a non-POST method on the sentry route', async () => {
    const { env, ctx } = makeEnv('s3cret')
    const res = await handleWebhook(new Request('https://worker.example/webhooks/sentry/api?token=s3cret'), env, ctx)
    expect(res.status).toBe(405)
  })

  it('404s an unknown slug', async () => {
    const { env, ctx } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/nope?token=s3cret', created), env, ctx)
    expect(res.status).toBe(404)
  })

  it('404s a slug whose check kind is not sentry', async () => {
    const { env, ctx } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/website?token=s3cret', created), env, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleWebhook — sentry payload & ingest', () => {
  it('400s on a wrong-shaped payload', async () => {
    const { env, ctx } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/api?token=s3cret', { data: 'oops' }), env, ctx)
    expect(res.status).toBe(400)
  })

  it('204s an ignored issue (no up/down transition)', async () => {
    const { env, ctx, inserted } = makeEnv('s3cret')
    const res = await handleWebhook(
      post('/webhooks/sentry/api?token=s3cret', { action: 'ignored', data: { issue: { status: 'ignored' } } }),
      env,
      ctx,
    )
    expect(res.status).toBe(204)
    expect(inserted.length).toBe(0)
  })

  it('200s a created issue and records a down check row + summary', async () => {
    const { env, ctx, inserted, kv } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/api?token=s3cret', created), env, ctx)
    expect(res.status).toBe(200)

    expect(inserted.length).toBe(1)
    const [slug, status] = inserted[0] as [string, string]
    expect(slug).toBe('api')
    expect(status).toBe('down')

    const summary = JSON.parse(kv.get('summary')!) as { slug: string, status: string }[]
    expect(summary.find(s => s.slug === 'api')?.status).toBe('down')
  })

  it('serves a site with no result yet as pending, and its first real result clears it without a status change', async () => {
    const { env, ctx, kv, waited } = makeEnv('s3cret')
    // A pending summary for `api` (as the cron writes before its first event), then the first event lands.
    kv.set('summary', JSON.stringify([{ slug: 'api', name: 'API', status: 'down', pending: true, responseTime: 0, uptimeDay: '100%', uptimeWeek: '100%', uptimeMonth: '100%', history: [] }]))
    const res = await handleWebhook(post('/webhooks/sentry/api?token=s3cret', resolved), env, ctx)
    expect(res.status).toBe(200)

    // No notification and no cache purge: down → up from a placeholder is not a change.
    expect(waited).toEqual([])
    const summary = JSON.parse(kv.get('summary')!) as { slug: string, status: string, pending?: boolean }[]
    expect(summary.find(s => s.slug === 'api')).toMatchObject({ status: 'up' })
    expect(summary.find(s => s.slug === 'api')).not.toHaveProperty('pending')
    // The untouched site has no result and no previous summary: not checked yet.
    expect(summary.find(s => s.slug === 'website')).toMatchObject({ status: 'down', pending: true })
  })

  it('still reports a real down → up change from a checked summary', async () => {
    const { env, ctx, kv, waited } = makeEnv('s3cret')
    kv.set('summary', JSON.stringify([{ slug: 'api', name: 'API', status: 'down', responseTime: 0, uptimeDay: '100%', uptimeWeek: '100%', uptimeMonth: '100%', history: [] }]))
    await handleWebhook(post('/webhooks/sentry/api?token=s3cret', resolved), env, ctx)
    expect(waited.length).toBeGreaterThan(0)
    await Promise.allSettled(waited)
  })

  it('200s a resolved issue and records an up check row', async () => {
    const { env, ctx, inserted } = makeEnv('s3cret')
    const res = await handleWebhook(post('/webhooks/sentry/api?token=s3cret', resolved), env, ctx)
    expect(res.status).toBe(200)
    const [slug, status] = inserted[0] as [string, string]
    expect(slug).toBe('api')
    expect(status).toBe('up')
  })
})
