import type { SiteResponse, StatusResponse } from '@statusbeam/core/contract'
import { describe, expect, it } from 'bun:test'
import { DEFAULT_TIMEOUT_MS, fetchSite, fetchStatus, loadStatus, MAX_BODY_BYTES, siteUrl, statusUrl } from './client'

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
    expect(statusUrl({ baseUrl: 'https://statusbeam.dev/sub///' })).toBe('https://statusbeam.dev/sub/api/status.json')
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

  it('cancels the unread body of a non-2xx response', async () => {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const result = await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(() => new Response(body, { status: 302 })).fetch })
    expect(result).toMatchObject({ ok: false, reason: 'http', detail: 'HTTP 302' })
    expect(cancelled).toBe(true)
  })

  it('yields unavailable (network) when fetch rejects, without throwing', async () => {
    const failing = stub(() => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchSite({ baseUrl: 'https://x.test' }, 'api', { fetch: failing.fetch })
    expect(result).toMatchObject({ ok: false, reason: 'network', detail: 'fetch failed', url: 'https://x.test/api/status/api.json' })
  })
})

describe('read deadline', () => {
  /** A 200 whose body stream sends the opening of a JSON document and then never ends. */
  const stalledBody = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":1,'))
    },
  }), { status: 200 })

  it('defaults to a deadline', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000)
  })

  it('refuses a body whose declared length is over MAX_BODY_BYTES without reading it', async () => {
    let pulled = false
    const huge = () => new Response(new ReadableStream({
      pull() {
        pulled = true
      },
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })
    const result = await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(huge).fetch })
    expect(result).toMatchObject({ ok: false, reason: 'contract', detail: `body of ${MAX_BODY_BYTES + 1} bytes exceeds the ${MAX_BODY_BYTES}-byte limit` })
    expect(pulled).toBe(false)
    // A body at the limit, or one without a declared length, is still read.
    const exact = JSON.stringify(status)
    expect(await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(() => new Response(exact, { headers: { 'content-length': String(exact.length) } })).fetch })).toMatchObject({ ok: true })
  })

  it('does not time out at once on an invalid or oversized timeoutMs', async () => {
    for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const answer = stub(() => new Promise<Response>(resolve => setTimeout(() => resolve(json(status)), 20))).fetch
      expect(await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: answer, timeoutMs }), String(timeoutMs)).toMatchObject({ ok: true })
    }
  })

  it('yields unavailable (network) when the body never ends past timeoutMs', async () => {
    const started = Date.now()
    const result = await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(stalledBody).fetch, timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ ok: false, reason: 'network', detail: 'read exceeded the 50 ms deadline' })
  })

  it('yields unavailable (network) when the request never answers past timeoutMs', async () => {
    const result = await fetchSite({ baseUrl: 'https://x.test' }, 'api', { fetch: stub(() => new Promise<Response>(() => {})).fetch, timeoutMs: 50 })
    expect(result).toMatchObject({ ok: false, reason: 'network', detail: 'read exceeded the 50 ms deadline' })
  })

  it('still honours a caller abort before the deadline, during the body read', async () => {
    const caller = new AbortController()
    const pending = fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(stalledBody).fetch, signal: caller.signal, timeoutMs: 60_000 })
    setTimeout(() => caller.abort(new Error('page request cancelled')), 20)
    const started = Date.now()
    expect(await pending).toMatchObject({ ok: false, reason: 'network', detail: 'page request cancelled' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('passes the fetch a signal that aborts with the caller', async () => {
    const caller = new AbortController()
    let seen: AbortSignal | undefined
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return json(status)
    }) as typeof fetch
    expect(await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: impl, signal: caller.signal })).toMatchObject({ ok: true })
    expect(seen?.aborted).toBe(false)
    caller.abort()
    expect(seen?.aborted).toBe(true)
  })

  it('leaves no listeners on a reused caller signal when the runtime lacks AbortSignal.any', async () => {
    const any = AbortSignal.any
    const caller = new AbortController()
    const live = new Set<EventListenerOrEventListenerObject>()
    const add = caller.signal.addEventListener.bind(caller.signal)
    const remove = caller.signal.removeEventListener.bind(caller.signal)
    caller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
      live.add(listener)
      add(type, listener, options)
    }) as typeof caller.signal.addEventListener
    caller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      live.delete(listener)
      remove(type, listener)
    }) as typeof caller.signal.removeEventListener
    try {
      ;(AbortSignal as { any?: unknown }).any = undefined
      for (let i = 0; i < 3; i++) {
        expect(await fetchStatus({ baseUrl: 'https://x.test' }, { fetch: stub(() => json(status)).fetch, signal: caller.signal })).toMatchObject({ ok: true })
      }
    }
    finally {
      AbortSignal.any = any
    }
    expect(live.size).toBe(0)
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
      if (file.endsWith('.test.ts')) {
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
