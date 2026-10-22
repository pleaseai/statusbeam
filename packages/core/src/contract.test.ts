import type { SiteSummary } from './types'
import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { overallBadge, responseBadge, statusBadge, uptimeBadge } from './badge'
import {
  buildSiteResponse,
  buildStatusResponse,
  parsePeriod,
  routePaths,
  shieldsEndpointSchema,
  siteResponseSchema,
  statusResponseSchema,
} from './contract'

const site: SiteSummary = {
  slug: 'api',
  name: 'API',
  status: 'up',
  responseTime: 120,
  uptimeDay: '100%',
  uptimeWeek: '99.98%',
  uptimeMonth: '99.5%',
  history: [{ date: '2026-10-21', status: 'up', uptime: 1 }, { date: '2026-10-20', status: null, uptime: 1 }],
  responseHistory: [{ at: '2026-10-21T00:00:00.000Z', ms: 120 }],
}
const down: SiteSummary = { ...site, slug: 'web', name: 'Web', status: 'down', responseTime: 0 }
const now = new Date('2026-10-22T00:00:00.000Z')

describe('buildStatusResponse', () => {
  it('matches the legacy payload plus version, and parses under the schema', () => {
    const body = buildStatusResponse([site, down], now)
    const legacy = {
      status: 'major_outage',
      generatedAt: now.toISOString(),
      sites: [site, down].map(s => ({
        slug: s.slug,
        name: s.name,
        status: s.status,
        responseTime: s.responseTime,
        uptime: { day: s.uptimeDay, week: s.uptimeWeek, month: s.uptimeMonth },
      })),
    }
    expect(JSON.stringify(body)).toBe(JSON.stringify({ version: 1, ...legacy }))
    expect(statusResponseSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(true)
  })

  it('handles an empty site list', () => {
    expect(statusResponseSchema.parse(buildStatusResponse([], now)).status).toBe('operational')
  })
})

describe('buildSiteResponse', () => {
  it('is the SiteSummary plus version, and parses under the schema', () => {
    const body = buildSiteResponse(site)
    expect(JSON.stringify(body)).toBe(JSON.stringify({ version: 1, ...site }))
    expect(siteResponseSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(true)
  })

  it('accepts a snapshot without responseHistory', () => {
    const { responseHistory: _omit, ...legacy } = site
    expect(siteResponseSchema.safeParse(buildSiteResponse(legacy)).success).toBe(true)
  })

  it('rejects a body with the wrong version', () => {
    expect(siteResponseSchema.safeParse({ ...buildSiteResponse(site), version: 2 }).success).toBe(false)
  })
})

describe('a site not checked yet', () => {
  const pending: SiteSummary = { ...site, slug: 'new', name: 'New', status: 'down', pending: true, responseTime: 0 }

  it('is served with pending: true beside the placeholder down, and the schemas accept it', () => {
    const body = JSON.parse(JSON.stringify(buildStatusResponse([site, pending], now)))
    expect(statusResponseSchema.parse(body).sites[1]).toMatchObject({ slug: 'new', status: 'down', pending: true })
    const one = JSON.parse(JSON.stringify(buildSiteResponse(pending)))
    expect(siteResponseSchema.parse(one)).toMatchObject({ slug: 'new', status: 'down', pending: true })
  })

  it('is left out of the overall status, which is operational when every site is pending', () => {
    expect(buildStatusResponse([site, pending], now).status).toBe('operational')
    expect(buildStatusResponse([pending], now).status).toBe('operational')
    expect(buildStatusResponse([pending, down], now).status).toBe('major_outage')
  })

  it('still parses under a consumer schema that predates pending, reading as down', () => {
    // The v1 site shape before `pending`: a closed status enum, unknown keys stripped.
    const legacySite = z.object({ slug: z.string(), status: z.enum(['up', 'degraded', 'down']) })
    const legacy = z.object({ version: z.literal(1), sites: z.array(legacySite) })
    const body = JSON.parse(JSON.stringify(buildStatusResponse([pending], now)))
    expect(legacy.parse(body).sites).toEqual([{ slug: 'new', status: 'down' }])
    expect(legacySite.parse(buildSiteResponse(pending))).toEqual({ slug: 'new', status: 'down' })
  })
})

describe('badge bodies', () => {
  it('every badge builder output parses under shieldsEndpointSchema', () => {
    for (const badge of [overallBadge([site]), statusBadge(site), uptimeBadge(site, 'week'), responseBadge(down)]) {
      expect(shieldsEndpointSchema.safeParse(badge).success).toBe(true)
    }
  })
})

describe('parsePeriod', () => {
  it('passes valid windows through and defaults the rest to month', () => {
    expect(parsePeriod('day')).toBe('day')
    expect(parsePeriod('week')).toBe('week')
    expect(parsePeriod('month')).toBe('month')
    expect(parsePeriod('year')).toBe('month')
    expect(parsePeriod(null)).toBe('month')
    expect(parsePeriod(undefined)).toBe('month')
  })
})

describe('routePaths', () => {
  it('yields standalone paths', () => {
    const p = routePaths.standalone
    expect(p.status()).toBe('/api/status.json')
    expect(p.site('api')).toBe('/api/status/api.json')
    expect(p.badge()).toBe('/api/badge.json')
    expect(p.siteBadge('api')).toBe('/api/badge/api.json')
    expect(p.uptimeBadge('api')).toBe('/api/badge/api/uptime.json')
    expect(p.uptimeBadge('api', 'week')).toBe('/api/badge/api/uptime.json?period=week')
    expect(p.responseTimeBadge('api')).toBe('/api/badge/api/response-time.json')
  })

  it('yields plugin paths with slug and period as query params', () => {
    const p = routePaths.emdash
    const base = '/_emdash/api/plugins/statusbeam'
    expect(p.status()).toBe(`${base}/status`)
    expect(p.site('x')).toBe(`${base}/status?slug=x`)
    expect(p.badge()).toBe(`${base}/badge`)
    expect(p.siteBadge('x')).toBe(`${base}/badge?slug=x`)
    expect(p.uptimeBadge('x', 'week')).toBe(`${base}/badge-uptime?slug=x&period=week`)
    expect(p.uptimeBadge('x')).toBe(`${base}/badge-uptime?slug=x`)
    expect(p.responseTimeBadge('x')).toBe(`${base}/badge-response-time?slug=x`)
  })
})

describe('@statusbeam/core/contract subpath', () => {
  it('bundles without yaml', async () => {
    const result = await Bun.build({
      entrypoints: [new URL('./contract.ts', import.meta.url).pathname],
      target: 'node',
      format: 'esm',
      // No `outdir`: outputs stay in memory.
      external: ['zod'],
    })
    expect(result.success).toBe(true)
    const text = await result.outputs[0]!.text()
    expect(text).not.toMatch(/from\s+["']yaml["']|require\(["']yaml["']\)/)
    expect(text).not.toContain('parseDocument')
  })
})
