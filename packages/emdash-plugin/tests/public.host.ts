import type { SiteSummary } from '@statusbeam/core'
import type { MonitorState, PollSnapshot } from '../src/snapshot'
import type { Host } from './host-harness'
import { dayStatFromCounts, denseHistory, routePaths, shieldsEndpointSchema, siteResponseSchema, statusResponseSchema, validateConfig } from '@statusbeam/core'
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { PUBLIC_CACHE_CONTROL } from '../src/routes/public'
import { mergeSnapshots, POLL_SNAPSHOT_KEY, summariesFromSnapshot } from '../src/snapshot'
import { newHost } from './host-harness'

/**
 * The public routes through EmDash's production route boundary
 * (`dispatchPluginApiRequest`). The standalone handlers under `apps/web` run
 * here with their data layer replaced by the same summaries the plugin serves,
 * so each comparison is between two HTTP response bodies, not between
 * pre-serialization data.
 */
const web = { summary: [] as SiteSummary[] }
mock.module('../../../apps/web/src/lib/data', () => ({
  getSummary: async () => web.summary,
  getSite: async (slug: string) => web.summary.find(s => s.slug === slug),
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

const parsed = validateConfig(YAML)
if (!parsed.ok) {
  throw new Error('fixture configuration is invalid')
}
const config = parsed.config

/**
 * The plugin reads the real clock, where a test cannot freeze it. So each test
 * starts clear of UTC midnight (waiting past it when it is close) and captures
 * one time that the fixtures and the expectations share.
 */
const MIDNIGHT_MARGIN_MS = 20_000

async function clearOfMidnight(): Promise<Date> {
  const now = Date.now()
  const untilMidnight = 86_400_000 - (now % 86_400_000)
  if (untilMidnight < MIDNIGHT_MARGIN_MS) {
    await new Promise(resolve => setTimeout(resolve, untilMidnight + 100))
  }
  return new Date()
}

let today = new Date()
const isoDay = (ago: number) => new Date(today.getTime() - ago * 86_400_000).toISOString().slice(0, 10)

function monitor(slug: string, status: 'up' | 'degraded' | 'down', responseTime: number): MonitorState {
  const counts = [
    { day: isoDay(2), up: 9, degraded: 1, down: 0, total: 10 },
    { day: isoDay(1), up: 3, degraded: 0, down: 1, total: 4 },
    { day: isoDay(0), up: 1, degraded: 0, down: 0, total: 1 },
  ]
  return {
    slug,
    result: { slug, status, code: status === 'down' ? 500 : 200, responseTime, checkedAt: today.toISOString() },
    days: denseHistory(new Map(counts.map(row => [row.day, dayStatFromCounts(row)])), today),
    totals: Object.fromEntries(counts.map(row => [row.day, row.total])),
  }
}

function snapshotAt(): PollSnapshot {
  return {
    version: 2,
    updatedAt: today.toISOString(),
    deliveries: [],
    monitors: [monitor('website', 'up', 142), monitor('api', 'degraded', 2310), monitor('worker', 'up', 88)],
  }
}

let SNAPSHOT: PollSnapshot = snapshotAt()
let summary: SiteSummary[] = []

beforeEach(async () => {
  today = await clearOfMidnight()
  SNAPSHOT = snapshotAt()
  summary = summariesFromSnapshot(mergeSnapshots([{ key: POLL_SNAPSHOT_KEY, value: SNAPSHOT }]), config.sites, today)
  web.summary = summary
})

const normalize = (body: string) => body.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<now>"')

const ok = () => new Response('ok', { status: 200 })

async function newPublicHost(options: { yaml?: string, snapshot?: PollSnapshot | null } = {}): Promise<Host> {
  const host = await newHost(ok)
  await host.setConfig(options.yaml ?? YAML)
  if (options.snapshot !== null) {
    await host.setKv(POLL_SNAPSHOT_KEY, options.snapshot ?? SNAPSHOT)
  }
  return host
}

/** GET a `routePaths.emdash` path: the route name is its last segment, the query rides on the URL. */
async function pluginGet(host: Host, path: string): Promise<Response> {
  const parsedUrl = new URL(path, 'https://example.com')
  return host.dispatch(parsedUrl.pathname.split('/').at(-1) as string, { query: Object.fromEntries(parsedUrl.searchParams) })
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
    const host = await newPublicHost()
    const response = await pluginGet(host, routePaths.emdash.status())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(statusResponseSchema.safeParse(body).success).toBe(true)
    expect((body as { sites: unknown[] }).sites).toHaveLength(3)
    expect(body).not.toHaveProperty('success')

    const site = await (await pluginGet(host, routePaths.emdash.site('api'))).json()
    expect(siteResponseSchema.safeParse(site).success).toBe(true)
    expect(site).toMatchObject({ slug: 'api', status: 'degraded', responseTime: 2310 })
  })

  it('serves the paths core declares under the plugin route base', () => {
    expect(routePaths.emdash.status()).toBe('/_emdash/api/plugins/statusbeam/status')
    expect(routePaths.emdash.site('api')).toBe('/_emdash/api/plugins/statusbeam/status?slug=api')
    expect(routePaths.emdash.badge()).toBe('/_emdash/api/plugins/statusbeam/badge')
    expect(routePaths.emdash.uptimeBadge('api', 'week')).toBe('/_emdash/api/plugins/statusbeam/badge-uptime?slug=api&period=week')
    expect(routePaths.emdash.responseTimeBadge('api')).toBe('/_emdash/api/plugins/statusbeam/badge-response-time?slug=api')
  })

  it('serves valid shields.io endpoint bodies from every badge route', async () => {
    const host = await newPublicHost()
    const paths = [
      routePaths.emdash.badge(),
      routePaths.emdash.siteBadge('website'),
      routePaths.emdash.uptimeBadge('website', 'week'),
      routePaths.emdash.responseTimeBadge('website'),
    ]
    for (const path of paths) {
      const response = await pluginGet(host, path)
      expect(response.status).toBe(200)
      expect(shieldsEndpointSchema.safeParse(await response.json()).success, path).toBe(true)
    }
  })

  it('serves a response body equal to the standalone endpoint, generatedAt aside', async () => {
    const host = await newPublicHost()
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
      const actual = await pluginGet(host, pluginPath)
      expect(actual.status, pluginPath).toBe(expected.status)
      expect(normalize(await actual.text()), pluginPath).toBe(normalize(await expected.text()))
    }
  })

  it('serves a monitor not checked yet as pending, with a body equal to the standalone endpoint', async () => {
    const yaml = `${YAML}\n  - name: Fresh\n    url: https://fresh.example.com/`
    const fresh = validateConfig(yaml)
    if (!fresh.ok) {
      throw new Error('fixture configuration is invalid')
    }
    web.summary = summariesFromSnapshot(mergeSnapshots([{ key: POLL_SNAPSHOT_KEY, value: SNAPSHOT }]), fresh.config.sites, today)
    const host = await newPublicHost({ yaml })

    const site = await (await pluginGet(host, routePaths.emdash.site('fresh'))).json()
    expect(siteResponseSchema.parse(site)).toMatchObject({ slug: 'fresh', status: 'down', pending: true })
    const badge = await (await pluginGet(host, routePaths.emdash.siteBadge('fresh'))).json()
    expect(badge).toMatchObject({ message: 'not checked', color: 'lightgrey' })

    const cases: Array<[string, WebHandler, string]> = [
      [routePaths.emdash.status(), standalone.status, routePaths.standalone.status()],
      [routePaths.emdash.badge(), standalone.badge, routePaths.standalone.badge()],
      [routePaths.emdash.site('fresh'), standalone.site, routePaths.standalone.site('fresh')],
      [routePaths.emdash.siteBadge('fresh'), standalone.siteBadge, routePaths.standalone.siteBadge('fresh')],
      [routePaths.emdash.uptimeBadge('fresh', 'week'), standalone.uptime, routePaths.standalone.uptimeBadge('fresh', 'week')],
      [routePaths.emdash.responseTimeBadge('fresh'), standalone.response, routePaths.standalone.responseTimeBadge('fresh')],
    ]
    for (const [pluginPath, handler, standalonePath] of cases) {
      const slug = new URL(pluginPath, 'https://example.com').searchParams.get('slug') ?? ''
      const expected = await standaloneGet(handler, standalonePath, slug)
      const actual = await pluginGet(host, pluginPath)
      expect(actual.status, pluginPath).toBe(200)
      expect(normalize(await actual.text()), pluginPath).toBe(normalize(await expected.text()))
    }
  })

  it('marks a monitor as pending until its first real check, in the whole status body too', async () => {
    const host = await newPublicHost({ snapshot: null })
    const body = statusResponseSchema.parse(await (await pluginGet(host, routePaths.emdash.status())).json())
    expect(body.sites).toHaveLength(3)
    expect(body.sites.every(site => site.pending === true)).toBe(true)

    await host.setKv(POLL_SNAPSHOT_KEY, SNAPSHOT)
    const after = statusResponseSchema.parse(await (await pluginGet(host, routePaths.emdash.status())).json())
    expect(after.sites.some(site => site.pending)).toBe(false)
  })

  it('answers an unknown slug with the standalone 404 body', async () => {
    const host = await newPublicHost()
    const pairs: Array<[string, WebHandler, string]> = [
      [routePaths.emdash.site('nope'), standalone.site, routePaths.standalone.site('nope')],
      [routePaths.emdash.siteBadge('nope'), standalone.siteBadge, routePaths.standalone.siteBadge('nope')],
      [routePaths.emdash.uptimeBadge('nope'), standalone.uptime, routePaths.standalone.uptimeBadge('nope')],
      [routePaths.emdash.responseTimeBadge('nope'), standalone.response, routePaths.standalone.responseTimeBadge('nope')],
    ]
    for (const [pluginPath, handler, standalonePath] of pairs) {
      const expected = await standaloneGet(handler, standalonePath, 'nope')
      const actual = await pluginGet(host, pluginPath)
      expect(expected.status).toBe(404)
      expect(actual.status, pluginPath).toBe(404)
      expect(await actual.text(), pluginPath).toBe(await expected.text())
    }
  })

  it('falls back to the month window for an invalid or absent period, as standalone does', async () => {
    const host = await newPublicHost()
    const month = await (await pluginGet(host, routePaths.emdash.uptimeBadge('api', 'month'))).text()
    for (const query of ['&period=decade', '&period=', '']) {
      const path = `${routePaths.emdash.uptimeBadge('api')}${query}`
      const expected = await standaloneGet(standalone.uptime, `/api/badge/api/uptime.json${query.replace(/^&/, '?')}`, 'api')
      const actual = await (await pluginGet(host, path)).text()
      expect(actual, path).toBe(month)
      expect(actual, path).toBe(await expected.text())
    }
  })

  it('carries the route cacheControl on successful GETs, and not on a 404', async () => {
    const host = await newPublicHost()
    const standaloneCache = (await standaloneGet(standalone.status, '/api/status.json')).headers.get('cache-control')
    expect(standaloneCache).toBe(PUBLIC_CACHE_CONTROL)
    for (const path of [routePaths.emdash.status(), routePaths.emdash.site('api'), routePaths.emdash.badge(), routePaths.emdash.uptimeBadge('api'), routePaths.emdash.responseTimeBadge('api')]) {
      expect((await pluginGet(host, path)).headers.get('cache-control'), path).toBe(standaloneCache)
    }

    const miss = await pluginGet(host, routePaths.emdash.site('nope'))
    expect(miss.headers.get('cache-control')).not.toContain('s-maxage')
  })

  it('answers GET only, with the host\'s 405 and an Allow header', async () => {
    const host = await newPublicHost()
    for (const route of ['status', 'badge', 'badge-uptime', 'badge-response-time']) {
      const response = await host.dispatch(route, { method: 'POST', body: '{}' })
      expect(response.status, route).toBe(405)
      expect(response.headers.get('allow'), route).toBe('GET')
    }
  })

  it('answers as standalone does with no data when the configuration is absent, invalid, or rejected by the plugin rules', async () => {
    const duplicateSlugs = 'name: Test\nsites:\n  - name: website\n    url: https://a.example.com/\n  - name: website\n    url: https://b.example.com/'
    for (const yaml of ['', 'name: Test\nsites: [oops', duplicateSlugs]) {
      const host = await newPublicHost({ yaml, snapshot: null })
      web.summary = []
      const status = await pluginGet(host, routePaths.emdash.status())
      expect(status.status).toBe(200)
      expect(normalize(await status.text())).toBe(normalize(await (await standaloneGet(standalone.status, '/api/status.json')).text()))
      const badge = await pluginGet(host, routePaths.emdash.badge())
      expect(await badge.text()).toBe(await (await standaloneGet(standalone.badge, '/api/badge.json')).text())
      const site = await pluginGet(host, routePaths.emdash.site('website'))
      expect(site.status).toBe(404)
      web.summary = summary
    }
  })

  it('serves a rejected configuration exactly like an absent one, even with a snapshot for its monitors', async () => {
    const duplicate = ['name: Test', 'sites:', '  - name: api', '    url: https://one.example.com/', '  - name: api', '    url: https://two.example.com/'].join('\n')
    const rejected = await newPublicHost({ yaml: duplicate })
    const absent = await newHost(ok)
    for (const path of [routePaths.emdash.status(), routePaths.emdash.badge(), routePaths.emdash.site('api'), routePaths.emdash.responseTimeBadge('api')]) {
      const served = await pluginGet(rejected, path)
      const empty = await pluginGet(absent, path)
      expect(served.status, path).toBe(empty.status)
      expect(normalize(await served.text()), path).toBe(normalize(await empty.text()))
    }
    expect(((await (await pluginGet(rejected, routePaths.emdash.status())).json()) as { sites: unknown[] }).sites).toEqual([])
  })
})
