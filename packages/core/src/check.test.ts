import { describe, expect, it } from 'bun:test'
import { checkSite, deriveStatus, deriveStatuspageStatus, statuspageSummaryUrl } from './check'
import { siteSchema } from './config'

const site = siteSchema.parse({ name: 'Example', url: 'https://example.com' })

/** A minimal Statuspage summary.json body for the given indicator/components. */
function statuspageResponse(body: unknown): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}

const claudeSummary = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { id: 'abc', name: 'Claude API (api.anthropic.com)', status: 'major_outage' },
    { id: 'def', name: 'claude.ai', status: 'degraded_performance' },
  ],
}

describe('deriveStatus', () => {
  it('is up for an expected, fast response', () => {
    expect(deriveStatus(200, 100, site)).toBe('up')
  })

  it('is degraded when slower than maxResponseTime', () => {
    expect(deriveStatus(200, site.maxResponseTime + 1, site)).toBe('degraded')
  })

  it('is down for an unexpected status code', () => {
    expect(deriveStatus(500, 100, site)).toBe('down')
  })
})

describe('checkSite', () => {
  it('reports down when the request throws', async () => {
    const result = await checkSite(site, {
      fetchImpl: () => Promise.reject(new Error('network')),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(0)
    expect(result.error).toBe('network')
  })

  it('maps a successful fetch to a check result', async () => {
    let t = 0
    const result = await checkSite(site, {
      fetchImpl: () => Promise.resolve(new Response('', { status: 200 })),
      now: () => (t += 50),
    })
    expect(result.status).toBe('up')
    expect(result.code).toBe(200)
    expect(result.slug).toBe('example')
  })

  it('dispatches an aigateway check to the gateway adapter', async () => {
    const aigatewaySite = siteSchema.parse({
      name: 'Claude Opus 4.5',
      check: 'aigateway',
      aigateway: { provider: 'vercel', model: 'anthropic/claude-opus-4.5' },
    })
    const seen: string[] = []
    const result = await checkSite(aigatewaySite, {
      fetchImpl: (url) => {
        seen.push(url)
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            id: 'anthropic/claude-opus-4.5',
            endpoints: [{
              provider_name: 'anthropic',
              status: 0,
              uptime_last_1h: 100,
              latency_last_1h: { p50: 814, p95: 1673 },
            }],
          },
        }), { status: 200 }))
      },
      now: () => 0,
    })
    expect(seen[0]).toBe('https://ai-gateway.vercel.sh/v1/models/anthropic/claude-opus-4.5/endpoints')
    expect(result.status).toBe('up')
    expect(result.code).toBe(200)
    // The gateway's published p50, not the round-trip of the API call.
    expect(result.responseTime).toBe(814)
  })
})

describe('statuspageSummaryUrl', () => {
  it('appends the API path to a bare page URL', () => {
    expect(statuspageSummaryUrl('https://status.claude.com'))
      .toBe('https://status.claude.com/api/v2/summary.json')
  })

  it('strips a trailing slash before appending', () => {
    expect(statuspageSummaryUrl('https://www.vercel-status.com/'))
      .toBe('https://www.vercel-status.com/api/v2/summary.json')
  })

  it('strips multiple trailing slashes', () => {
    expect(statuspageSummaryUrl('https://status.claude.com///'))
      .toBe('https://status.claude.com/api/v2/summary.json')
  })

  it('leaves an explicit api/v2 endpoint untouched', () => {
    const url = 'https://status.claude.com/api/v2/status.json'
    expect(statuspageSummaryUrl(url)).toBe(url)
  })

  it('leaves an explicit api/v2 endpoint untouched even with trailing slashes', () => {
    expect(statuspageSummaryUrl('https://status.claude.com/api/v2/status.json///'))
      .toBe('https://status.claude.com/api/v2/status.json')
  })
})

describe('deriveStatuspageStatus', () => {
  it('maps every overall indicator when no component is given', () => {
    expect(deriveStatuspageStatus({ status: { indicator: 'none' } })).toBe('up')
    expect(deriveStatuspageStatus({ status: { indicator: 'minor' } })).toBe('degraded')
    expect(deriveStatuspageStatus({ status: { indicator: 'major' } })).toBe('down')
    expect(deriveStatuspageStatus({ status: { indicator: 'critical' } })).toBe('down')
    expect(deriveStatuspageStatus({ status: { indicator: 'maintenance' } })).toBe('degraded')
  })

  it('maps every component status', () => {
    const status = (s: string) => deriveStatuspageStatus({ components: [{ name: 'X', status: s }] }, 'X')
    expect(status('operational')).toBe('up')
    expect(status('degraded_performance')).toBe('degraded')
    expect(status('partial_outage')).toBe('degraded')
    expect(status('major_outage')).toBe('down')
    expect(status('under_maintenance')).toBe('degraded')
  })

  it('reads a specific component by case-insensitive name', () => {
    expect(deriveStatuspageStatus(claudeSummary, 'claude api (api.anthropic.com)')).toBe('down')
    expect(deriveStatuspageStatus(claudeSummary, 'claude.ai')).toBe('degraded')
  })

  it('reads a specific component by id', () => {
    expect(deriveStatuspageStatus(claudeSummary, 'abc')).toBe('down')
  })

  it('trims surrounding whitespace before matching id or name', () => {
    expect(deriveStatuspageStatus(claudeSummary, '  abc  ')).toBe('down')
    expect(deriveStatuspageStatus(claudeSummary, '  claude.ai  ')).toBe('degraded')
  })

  it('throws when a named component is missing', () => {
    expect(() => deriveStatuspageStatus(claudeSummary, 'nonexistent')).toThrow(/not found/)
  })

  it('falls back to degraded for unknown status strings', () => {
    expect(deriveStatuspageStatus({ status: { indicator: 'weird' } })).toBe('degraded')
    expect(deriveStatuspageStatus({ components: [{ name: 'X', status: 'weird' }] }, 'X')).toBe('degraded')
  })
})

describe('checkSite (statuspage)', () => {
  const pageSite = siteSchema.parse({ name: 'Claude', url: 'https://status.claude.com', check: 'statuspage' })
  const componentSite = siteSchema.parse({
    name: 'Claude API',
    url: 'https://status.claude.com',
    check: 'statuspage',
    component: 'Claude API (api.anthropic.com)',
  })

  it('grades the overall page indicator', async () => {
    const result = await checkSite(pageSite, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('up')
    expect(result.code).toBe(200)
    expect(result.slug).toBe('claude')
  })

  it('grades a single configured component', async () => {
    const result = await checkSite(componentSite, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.slug).toBe('claude-api')
  })

  it('reports down when a configured component is not on the page', async () => {
    const missing = siteSchema.parse({
      name: 'Claude API',
      url: 'https://status.claude.com',
      check: 'statuspage',
      component: 'Nonexistent Service',
    })
    const result = await checkSite(missing, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('down')
    expect(result.error).toMatch(/not found/)
    // The fetch completed (200) — a config typo must not masquerade as a
    // network failure (code 0) in the persisted history.
    expect(result.code).toBe(200)
  })

  it('reports down with the real status code on a non-JSON body', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: () => Promise.resolve(new Response('<html>not json</html>', { status: 200 })),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toBeDefined()
  })

  it('reports down on a JSON null body instead of throwing', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: () => Promise.resolve(new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toMatch(/failed validation/)
  })

  it('reports down when the body has the wrong shape', async () => {
    // Valid JSON, but `status` is a string where an object is expected — the
    // schema rejects it instead of grading a malformed payload.
    const result = await checkSite(pageSite, {
      fetchImpl: statuspageResponse({ status: 'oops', components: 'nope' }),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toMatch(/failed validation/)
  })

  it('fetches the derived summary.json endpoint', async () => {
    let requested = ''
    await checkSite(pageSite, {
      fetchImpl: (url) => {
        requested = url
        return statuspageResponse(claudeSummary)()
      },
      now: () => 0,
    })
    expect(requested).toBe('https://status.claude.com/api/v2/summary.json')
  })

  it('reports down on a non-2xx API response', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 503 })),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(503)
    expect(result.error).toContain('503')
  })

  it('reports down when the fetch throws', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: () => Promise.reject(new Error('network')),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(0)
    expect(result.error).toBe('network')
  })
})

describe('checkSite (incidentio)', () => {
  // incident.io serves a Statuspage-compatible summary.json, so the payload,
  // URL derivation, and grading are shared; only the error label differs.
  const pageSite = siteSchema.parse({ name: 'incident.io', url: 'https://status.incident.io', check: 'incidentio' })

  it('grades the same Statuspage-format payload via the shared path', async () => {
    const result = await checkSite(pageSite, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('up')
    expect(result.code).toBe(200)
  })

  it('grades a single configured component', async () => {
    const componentSite = siteSchema.parse({
      name: 'incident.io API',
      url: 'https://status.incident.io',
      check: 'incidentio',
      component: 'claude.ai',
    })
    const result = await checkSite(componentSite, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('degraded')
  })

  it('derives the summary.json endpoint the same way', async () => {
    let requested = ''
    await checkSite(pageSite, {
      fetchImpl: (url) => {
        requested = url
        return statuspageResponse(claudeSummary)()
      },
      now: () => 0,
    })
    expect(requested).toBe('https://status.incident.io/api/v2/summary.json')
  })

  it('labels the API error with the incident.io provider', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 503 })),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.error).toBe('incident.io API returned 503')
  })

  it('labels a missing component with the incident.io provider', async () => {
    const missing = siteSchema.parse({
      name: 'incident.io API',
      url: 'https://status.incident.io',
      check: 'incidentio',
      component: 'Nonexistent Service',
    })
    const result = await checkSite(missing, { fetchImpl: statuspageResponse(claudeSummary), now: () => 0 })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toBe('incident.io component not found: Nonexistent Service')
  })

  it('labels a validation failure with the incident.io provider', async () => {
    const result = await checkSite(pageSite, {
      fetchImpl: statuspageResponse({ status: 'oops', components: 'nope' }),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.error).toMatch(/^incident\.io summary\.json failed validation:/)
  })
})
