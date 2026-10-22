import type { SiteResponse, StatusResponse } from '@statusbeam/core/contract'
import { describe, expect, it } from 'bun:test'
import { fetchSite, fetchStatus, loadStatus, siteUrl, statusUrl } from './client'

const status: StatusResponse = {
  version: 1,
  status: 'degraded',
  generatedAt: '2026-10-22T00:00:00.000Z',
  sites: [{ slug: 'api', name: 'API', status: 'degraded', responseTime: 120, uptime: { day: '100%', week: '99.9%', month: '99.5%' } }],
}

const site: SiteResponse = {
  version: 1,
  slug: 'api',
  name: 'API',
  status: 'up',
  responseTime: 120,
  uptimeDay: '100%',
  uptimeWeek: '99.98%',
  uptimeMonth: '99.5%',
  history: [{ date: '2026-10-21', status: 'up', uptime: 1 }, { date: '2026-10-20', status: null, uptime: 1 }],
}

/** A fetch stub that records the URL it was called with and answers `respond()`. */
function stub(respond: () => Response | Promise<Response>): { fetch: typeof fetch, urls: string[] } {
  const urls: string[] = []
  const impl = async (input: string | URL | Request) => {
    urls.push(String(input))
    return respond()
  }
  return { fetch: impl as typeof fetch, urls }
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)

describe('url builders', () => {
  it('builds standalone URLs, tolerating a trailing slash', () => {
    expect(statusUrl({ baseUrl: 'https://statusbeam.dev/' })).toBe('https://statusbeam.dev/api/status.json')
    expect(siteUrl({ baseUrl: 'https://statusbeam.dev', flavor: 'standalone' }, 'a b')).toBe('https://statusbeam.dev/api/status/a%20b.json')
  })

  it('builds EmDash plugin URLs', () => {
    const source = { baseUrl: 'https://cms.example.com', flavor: 'emdash' as const }
    expect(statusUrl(source)).toBe('https://cms.example.com/_emdash/api/plugins/statusbeam/status')
    expect(siteUrl(source, 'api')).toBe('https://cms.example.com/_emdash/api/plugins/statusbeam/status?slug=api')
  })
})

describe('fetchStatus / fetchSite', () => {
  it('returns parsed data for a valid body', async () => {
    const s = stub(() => json(status))
    const result = await fetchStatus({ baseUrl: 'https://x.test', flavor: 'emdash' }, { fetch: s.fetch })
    expect(result).toEqual({ ok: true, data: status, url: 'https://x.test/_emdash/api/plugins/statusbeam/status' })
    expect(s.urls).toEqual(['https://x.test/_emdash/api/plugins/statusbeam/status'])

    const siteResult = await fetchSite({ baseUrl: 'https://x.test' }, 'api', { fetch: stub(() => json(site)).fetch })
    expect(siteResult.ok && siteResult.data.history).toEqual(site.history)
  })

  it('yields unavailable (contract) for a body that fails the schema', async () => {
    // An EmDash route that forgot `response: "raw"` wraps the body in an envelope.
    const result = await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(() => json({ success: true, data: status })).fetch })
    expect(result).toMatchObject({ ok: false, reason: 'contract' })
  })

  it('yields unavailable (contract) for a body that is not JSON', async () => {
    const result = await fetchSite({ baseUrl: 'https://x.test' }, 'api', { fetch: stub(() => new Response('<html>')).fetch })
    expect(result).toMatchObject({ ok: false, reason: 'contract' })
  })

  it('yields unavailable (http) for a non-2xx response', async () => {
    const result = await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(() => json(status, { status: 503 })).fetch })
    expect(result).toMatchObject({ ok: false, reason: 'http', detail: 'HTTP 503' })
  })

  it('yields unavailable (network) when fetch rejects, without throwing', async () => {
    const failing = stub(() => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchSite({ baseUrl: 'https://x.test' }, 'api', { fetch: failing.fetch })
    expect(result).toMatchObject({ ok: false, reason: 'network', detail: 'fetch failed', url: 'https://x.test/api/status/api.json' })
  })
})

describe('package surface (NFR-1)', () => {
  it('imports only the core contract subpath, relative modules and CSS', async () => {
    const allowed = /^(?:@statusbeam\/core\/contract|\.{1,2}\/.*)$/
    // `… from 'x'`, side-effect `import 'x'`, and dynamic `import('x')`.
    const pattern = /\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm
    const files = new Bun.Glob('**/*.{ts,astro}').scan({ cwd: import.meta.dir })
    const specifiers: string[] = []
    for await (const file of files) {
      // `block.ts`, `plugin.ts` and `astro/` are the opt-in EmDash entry points (FR-22).
      // They may import `emdash`; entry-graph.test.ts proves the entries never reach them.
      if (file.endsWith('.test.ts') || file === 'block.ts' || file === 'plugin.ts' || file.startsWith('astro/') || file.startsWith('types/')) {
        continue
      }
      const text = await Bun.file(`${import.meta.dir}/${file}`).text()
      for (const m of text.matchAll(pattern)) {
        specifiers.push((m[1] ?? m[2] ?? m[3])!)
      }
    }
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(s => !allowed.test(s))).toEqual([])
  })
})

describe('loadStatus', () => {
  it('reuses a pre-fetched result instead of fetching', async () => {
    const s = stub(() => json(status))
    const prefetched = { ok: true as const, data: status, url: 'u' }
    expect(await loadStatus({ result: prefetched }, { fetch: s.fetch })).toBe(prefetched)
    expect(s.urls).toEqual([])
  })
})
