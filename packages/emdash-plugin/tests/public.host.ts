import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import type { SiteSummary } from '@statusbeam/core'
import type { MonitorState, ShardSnapshot } from '../src/snapshot'
import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { dayStatFromCounts, denseHistory, routePaths, shieldsEndpointSchema, siteResponseSchema, statusResponseSchema, validateConfig } from '@statusbeam/core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeSnapshots, summariesFromSnapshot } from '../src/snapshot'

/**
 * The standalone handlers under `apps/web` run here with their data layer
 * replaced by the same summaries the plugin serves, so each comparison is
 * between two HTTP response bodies, not between pre-serialization data.
 */
const web = vi.hoisted(() => ({ summary: [] as unknown[] }))
vi.mock('../../../apps/web/src/lib/data', () => ({
  getSummary: async () => web.summary,
  getSite: async (slug: string) => (web.summary as Array<{ slug: string }>).find(s => s.slug === slug),
}))

const YAML = [
  'name: Test',
  'sites:',
  '  - name: Website',
  '    url: https://website.example.com/',
  '  - name: API',
  '    url: https://api.example.com/',
  '  - name: Worker',
  '    url: https://worker.example.com/',
].join('\n')

const config = validateConfig(YAML)
if (!config.ok) {
  throw new Error('fixture configuration is invalid')
}

const today = new Date()
const isoDay = (ago: number) => new Date(today.getTime() - ago * 86_400_000).toISOString().slice(0, 10)

function monitor(slug: string, status: 'up' | 'degraded' | 'down', responseTime: number, extra: Partial<MonitorState> = {}): MonitorState {
  const days = new Map([
    [isoDay(2), dayStatFromCounts({ day: isoDay(2), up: 9, degraded: 1, down: 0, total: 10 })],
    [isoDay(1), dayStatFromCounts({ day: isoDay(1), up: 3, degraded: 0, down: 1, total: 4 })],
    [isoDay(0), dayStatFromCounts({ day: isoDay(0), up: 1, degraded: 0, down: 0, total: 1 })],
  ])
  return {
    slug,
    result: { slug, status, code: status === 'down' ? 500 : 200, responseTime, checkedAt: today.toISOString() },
    days: denseHistory(days, today),
    ...extra,
  }
}

const SNAPSHOT: ShardSnapshot = {
  version: 2,
  shard: 0,
  updatedAt: today.toISOString(),
  deliveries: [],
  monitors: [
    monitor('website', 'up', 142),
    monitor('api', 'degraded', 2310),
    // An unsupported monitor keeps its last real result; only the warning marks it.
    monitor('worker', 'up', 88, { warning: { limit: 'body', since: today.toISOString(), lastSeen: today.toISOString() } }),
  ],
}

const summary: SiteSummary[] = summariesFromSnapshot(mergeSnapshots([{ key: 'snapshot:0', value: SNAPSHOT }]), config.config.sites, today)

const normalize = (body: string) => body.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<now>"')

let host: PluginRuntimeTestHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

async function newHost(options: { yaml?: string, snapshot?: ShardSnapshot | null } = {}): Promise<PluginRuntimeTestHost> {
  host = await createPluginRuntimeTestHost()
  await host.fixtures.plugin.setting('config', options.yaml ?? YAML)
  if (options.snapshot !== null) {
    await host.fixtures.plugin.kv('snapshot:0', options.snapshot ?? SNAPSHOT)
  }
  return host
}

/** GET a `routePaths.emdash` path: the route name is its last segment, the query rides on the URL. */
async function pluginGet(h: PluginRuntimeTestHost, path: string): Promise<Response> {
  const name = new URL(path, 'https://example.com').pathname.split('/').at(-1) as string
  return h.actions.routes.request(name, { url: `https://example.com${path}`, method: 'GET' })
}

type WebHandler = (context: { params: Record<string, string>, url: URL }) => Promise<Response>
interface WebModules {
  status: WebHandler
  site: WebHandler
  badge: WebHandler
  siteBadge: WebHandler
  uptime: WebHandler
  response: WebHandler
}
let standalone: WebModules

beforeAll(async () => {
  web.summary = summary
  standalone = {
    status: (await import('../../../apps/web/src/pages/api/status.json')).GET as unknown as WebHandler,
    site: (await import('../../../apps/web/src/pages/api/status/[slug].json')).GET as unknown as WebHandler,
    badge: (await import('../../../apps/web/src/pages/api/badge.json')).GET as unknown as WebHandler,
    siteBadge: (await import('../../../apps/web/src/pages/api/badge/[slug].json')).GET as unknown as WebHandler,
    uptime: (await import('../../../apps/web/src/pages/api/badge/[slug]/uptime.json')).GET as unknown as WebHandler,
    response: (await import('../../../apps/web/src/pages/api/badge/[slug]/response-time.json')).GET as unknown as WebHandler,
  }
})

async function standaloneGet(handler: WebHandler, path: string, slug = ''): Promise<Response> {
  return handler({ params: { slug }, url: new URL(path, 'https://example.com') })
}

describe('the public status routes', () => {
  it('serves an unwrapped status body that the contract accepts', async () => {
    const h = await newHost()
    const response = await pluginGet(h, routePaths.emdash.status())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(statusResponseSchema.safeParse(body).success).toBe(true)
    expect((body as { sites: unknown[] }).sites).toHaveLength(3)
    expect(body).not.toHaveProperty('success')

    const site = await (await pluginGet(h, routePaths.emdash.site('api'))).json()
    expect(siteResponseSchema.safeParse(site).success).toBe(true)
    expect(site).toMatchObject({ slug: 'api', status: 'degraded', responseTime: 2310 })
  })

  it('keeps an unsupported monitor on its last real result', async () => {
    const h = await newHost()
    const site = await (await pluginGet(h, routePaths.emdash.site('worker'))).json()
    expect(site).toMatchObject({ slug: 'worker', status: 'up', responseTime: 88 })
  })

  it('serves valid shields.io endpoint bodies from every badge route', async () => {
    const h = await newHost()
    const paths = [
      routePaths.emdash.badge(),
      routePaths.emdash.siteBadge('website'),
      routePaths.emdash.uptimeBadge('website', 'week'),
      routePaths.emdash.responseTimeBadge('website'),
    ]
    for (const path of paths) {
      const response = await pluginGet(h, path)
      expect(response.status).toBe(200)
      expect(shieldsEndpointSchema.safeParse(await response.json()).success, path).toBe(true)
    }
  })

  it('serves a response body equal to the standalone endpoint, generatedAt aside', async () => {
    const h = await newHost()
    const cases: Array<[string, WebHandler, string]> = [
      [routePaths.emdash.status(), standalone.status, routePaths.standalone.status()],
      [routePaths.emdash.badge(), standalone.badge, routePaths.standalone.badge()],
    ]
    for (const site of summary) {
      cases.push(
        [routePaths.emdash.site(site.slug), standalone.site, routePaths.standalone.site(site.slug)],
        [routePaths.emdash.siteBadge(site.slug), standalone.siteBadge, routePaths.standalone.siteBadge(site.slug)],
        [routePaths.emdash.responseTimeBadge(site.slug), standalone.response, routePaths.standalone.responseTimeBadge(site.slug)],
        ...(['day', 'week', 'month'] as const).map((period): [string, WebHandler, string] => [
          routePaths.emdash.uptimeBadge(site.slug, period),
          standalone.uptime,
          routePaths.standalone.uptimeBadge(site.slug, period),
        ]),
      )
    }

    for (const [pluginPath, handler, standalonePath] of cases) {
      const slug = new URL(pluginPath, 'https://example.com').searchParams.get('slug') ?? ''
      const expected = await standaloneGet(handler, standalonePath, slug)
      const actual = await pluginGet(h, pluginPath)
      expect(actual.status, pluginPath).toBe(expected.status)
      expect(normalize(await actual.text()), pluginPath).toBe(normalize(await expected.text()))
    }
  })

  it('answers an unknown slug with the standalone 404 body', async () => {
    const h = await newHost()
    const pairs: Array<[string, WebHandler, string]> = [
      [routePaths.emdash.site('nope'), standalone.site, routePaths.standalone.site('nope')],
      [routePaths.emdash.siteBadge('nope'), standalone.siteBadge, routePaths.standalone.siteBadge('nope')],
      [routePaths.emdash.uptimeBadge('nope'), standalone.uptime, routePaths.standalone.uptimeBadge('nope')],
      [routePaths.emdash.responseTimeBadge('nope'), standalone.response, routePaths.standalone.responseTimeBadge('nope')],
    ]
    for (const [pluginPath, handler, standalonePath] of pairs) {
      const expected = await standaloneGet(handler, standalonePath, 'nope')
      const actual = await pluginGet(h, pluginPath)
      expect(expected.status).toBe(404)
      expect(actual.status, pluginPath).toBe(404)
      expect(await actual.text(), pluginPath).toBe(await expected.text())
    }
  })

  it('falls back to the month window for an invalid or absent period, as standalone does', async () => {
    const h = await newHost()
    const month = await (await pluginGet(h, routePaths.emdash.uptimeBadge('api', 'month'))).text()
    for (const query of ['&period=decade', '&period=', '']) {
      const path = `${routePaths.emdash.uptimeBadge('api')}${query}`
      const expected = await standaloneGet(standalone.uptime, `/api/badge/api/uptime.json${query.replace('&', '?')}`, 'api')
      const actual = await (await pluginGet(h, path)).text()
      expect(actual, path).toBe(month)
      expect(actual, path).toBe(await expected.text())
    }
  })

  it('carries the route cacheControl on successful GETs, and not on a 404', async () => {
    const h = await newHost()
    const ok = await pluginGet(h, routePaths.emdash.status())
    const standaloneCache = (await standaloneGet(standalone.status, '/api/status.json')).headers.get('cache-control')
    expect(standaloneCache).toBe('public, s-maxage=60, stale-while-revalidate=600')
    expect(ok.headers.get('cache-control')).toBe(standaloneCache)

    const miss = await pluginGet(h, routePaths.emdash.site('nope'))
    expect(miss.headers.get('cache-control')).not.toContain('s-maxage')
  })

  it('answers as standalone does with no data when the configuration is absent or invalid', async () => {
    for (const yaml of ['', 'name: Test\nsites: [oops']) {
      const h = await newHost({ yaml, snapshot: null })
      web.summary = []
      const status = await pluginGet(h, routePaths.emdash.status())
      expect(status.status).toBe(200)
      expect(normalize(await status.text())).toBe(normalize(await (await standaloneGet(standalone.status, '/api/status.json')).text()))
      const badge = await pluginGet(h, routePaths.emdash.badge())
      expect(await badge.text()).toBe(await (await standaloneGet(standalone.badge, '/api/badge.json')).text())
      const site = await pluginGet(h, routePaths.emdash.site('website'))
      expect(site.status).toBe(404)
      await h.dispose()
      host = undefined
      web.summary = summary
    }
  })
})
