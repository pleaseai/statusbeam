import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import type { DayBucket } from '../src/buckets'
import type { WebhookSnapshot } from '../src/snapshot'
import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { afterEach, describe, expect, it } from 'vitest'

/** The webhook routes through EmDash's production route dispatch (host-side method check, text body, raw response). */

let host: PluginRuntimeTestHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

const CONFIG = [
  'name: Test',
  'sites:',
  '  - name: web',
  '    check: statuspage',
  '    url: https://status.example.com/',
].join('\n')

const BASE = 'https://plugin.test/_emdash/api/plugins/statusbeam'

async function newHost(secret?: string): Promise<PluginRuntimeTestHost> {
  host = await createPluginRuntimeTestHost()
  await host.fixtures.plugin.setting('config', CONFIG)
  if (secret) {
    await host.fixtures.plugin.setting('webhookSecret', secret)
  }
  return host
}

function send(h: PluginRuntimeTestHost, query: string, init: { method?: string } = {}): Promise<Response> {
  const method = init.method ?? 'POST'
  return h.actions.routes.request('webhooks/statuspage', {
    url: `${BASE}/webhooks/statuspage?${query}`,
    method,
    ...(method === 'GET' ? {} : { rawBody: JSON.stringify({ page: { status_indicator: 'major' } }) }),
  })
}

describe('the webhook routes', () => {
  it('rejects every request while no secret is configured', async () => {
    const h = await newHost()
    expect((await send(h, 'slug=web&token=anything')).status).toBe(401)
    expect((await send(h, 'slug=web')).status).toBe(401)
    expect(await h.inspect.kv.list()).toEqual([])
  })

  it('rejects a mismatched token without touching storage', async () => {
    const h = await newHost('right')
    expect((await send(h, 'slug=web&token=wrong')).status).toBe(401)
    expect(await h.inspect.kv.list()).toEqual([])
    expect(await h.inspect.storage.list('buckets')).toEqual([])
  })

  it('stores a valid event in the webhook bucket row and the webhook snapshot key', async () => {
    const h = await newHost('right')

    const response = await send(h, 'slug=web&token=right')

    expect(response.status).toBe(200)
    const rows = (await h.inspect.storage.list<DayBucket>('buckets')).map(entry => entry.data)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slug: 'web', down: 1, total: 1 })
    const snapshot = await h.inspect.kv.get<WebhookSnapshot>('snapshot:webhook:web')
    expect(snapshot?.monitor.result).toMatchObject({ slug: 'web', status: 'down', code: 200 })
  })

  it('answers 404 for an unknown slug and 405 for a non-POST request', async () => {
    const h = await newHost('right')
    expect((await send(h, 'slug=nope&token=right')).status).toBe(404)
    expect((await send(h, 'slug=web&token=right', { method: 'GET' })).status).toBe(405)
    expect(await h.inspect.kv.list()).toEqual([])
  })
})
