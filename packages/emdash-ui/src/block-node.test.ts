import { describe, expect, it, spyOn } from 'bun:test'
import { blockFetchOptions, parseAllowedOrigins, selectFromBlock } from './block-node'
import { fetchStatus } from './client'

describe('selectFromBlock', () => {
  it('maps a banner block to a standalone source by default', () => {
    expect(selectFromBlock({ baseUrl: 'https://status.test' })).toEqual({
      ok: true,
      view: 'banner',
      source: { baseUrl: 'https://status.test', flavor: 'standalone' },
    })
  })

  it('maps a site block with a slug and the emdash flavor', () => {
    expect(selectFromBlock({ view: 'site', slug: ' api ', baseUrl: 'https://cms.test', flavor: 'emdash' })).toEqual({
      ok: true,
      view: 'site',
      slug: 'api',
      source: { baseUrl: 'https://cms.test', flavor: 'emdash' },
    })
  })

  it('refuses a site block without a slug', () => {
    expect(selectFromBlock({ view: 'site', baseUrl: 'https://status.test' })).toMatchObject({ ok: false })
  })

  it('refuses a missing, relative or non-http(s) base URL', () => {
    for (const baseUrl of [undefined, '', '/api', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(selectFromBlock({ baseUrl })).toMatchObject({ ok: false })
    }
  })

  it('refuses a base URL with credentials, a query string or a fragment', () => {
    for (const baseUrl of ['https://user:pw@status.test', 'https://user@status.test', 'https://status.test/?x=1', 'https://status.test/?', 'http://example.com:8080/admin#', 'https://status.test/#top']) {
      expect(selectFromBlock({ baseUrl }), baseUrl).toMatchObject({ ok: false, reason: expect.stringMatching(/credentials|query string or a fragment/) })
    }
  })

  it('refuses localhost and any .localhost name', () => {
    for (const baseUrl of ['http://localhost:4321', 'http://LOCALHOST./', 'https://admin.localhost']) {
      expect(selectFromBlock({ baseUrl }), baseUrl).toMatchObject({ ok: false, reason: 'baseUrl must not point at localhost' })
    }
  })

  it('refuses loopback, private, link-local and unspecified IPv4 literals, in any spelling', () => {
    const hosts = ['127.0.0.1', '127.255.1.2', '2130706433', '0x7f.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0']
    for (const host of hosts) {
      expect(selectFromBlock({ baseUrl: `http://${host}:8080` }), host).toMatchObject({ ok: false, reason: expect.stringContaining('must not be a loopback') })
    }
  })

  it('refuses loopback, unspecified, link-local, unique-local and IPv4-mapped private IPv6 literals', () => {
    const hosts = ['[::1]', '[::]', '[fe80::1]', '[febf::1]', '[fc00::1]', '[fd12:3456::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]']
    for (const host of hosts) {
      expect(selectFromBlock({ baseUrl: `http://${host}/` }), host).toMatchObject({ ok: false, reason: expect.stringContaining('must not be a loopback') })
    }
  })

  it('still accepts ordinary public hosts and addresses next to the refused ranges', () => {
    const accepted = ['https://status.example.com/prefix', 'http://172.32.0.1', 'http://11.0.0.1', 'https://[2606:4700::1111]', 'http://[::ffff:8.8.8.8]', 'https://localhost.example.com']
    for (const baseUrl of accepted) {
      expect(selectFromBlock({ baseUrl }), baseUrl).toMatchObject({ ok: true })
    }
  })

  it('accepts localhost and private literals only with allowPrivateHosts, and still refuses a query or a fragment', () => {
    for (const baseUrl of ['http://127.0.0.1:4420', 'http://localhost:4420', 'http://[::1]:4420', 'http://192.168.1.10']) {
      expect(selectFromBlock({ baseUrl }), baseUrl).toMatchObject({ ok: false })
      expect(selectFromBlock({ baseUrl }, { allowPrivateHosts: true }), baseUrl).toMatchObject({ ok: true, source: { baseUrl } })
    }
    for (const baseUrl of ['http://127.0.0.1:8080/admin#', 'http://127.0.0.1:8080/?x=1', 'http://u:p@127.0.0.1']) {
      expect(selectFromBlock({ baseUrl }, { allowPrivateHosts: true }), baseUrl).toMatchObject({ ok: false })
    }
  })
})

describe('selectFromBlock with allowedOrigins', () => {
  const allowedOrigins = ['https://status.example.com', 'http://10.0.0.5:8080']

  it('accepts a base URL on an allowed origin, including an approved private address', () => {
    for (const baseUrl of ['https://status.example.com', 'https://status.example.com/prefix', 'http://10.0.0.5:8080/status']) {
      expect(selectFromBlock({ baseUrl }, { allowedOrigins }), baseUrl).toMatchObject({ ok: true, source: { baseUrl } })
    }
  })

  it('refuses any other origin without making a request', () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      for (const baseUrl of ['https://other.example.com', 'http://status.example.com', 'https://status.example.com:8443', 'https://internal.corp', 'http://10.0.0.5']) {
        expect(selectFromBlock({ baseUrl }, { allowedOrigins }), baseUrl).toEqual({
          ok: false,
          reason: `baseUrl origin ${new URL(baseUrl).origin} is not in the site's allowed origins`,
        })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    }
    finally {
      fetchSpy.mockRestore()
    }
  })

  it('refuses every block when the configured value is not an array, instead of falling back', () => {
    for (const bad of ['', 0, true, {}, null]) {
      const options = { allowedOrigins: bad as unknown as string[] }
      expect(selectFromBlock({ baseUrl: 'https://internal.corp' }, options), String(bad)).toEqual({ ok: false, reason: 'allowedOrigins must be an array of origins' })
    }
  })

  it('keeps the literal-address guard when the list is unset or empty', () => {
    for (const options of [{}, { allowedOrigins: [] }]) {
      expect(selectFromBlock({ baseUrl: 'https://internal.corp' }, options)).toMatchObject({ ok: true })
      expect(selectFromBlock({ baseUrl: 'http://10.0.0.5' }, options)).toMatchObject({ ok: false, reason: expect.stringContaining('must not be a loopback') })
    }
  })

  it('compares normalised origins: case, default ports and a trailing slash do not matter', () => {
    const list = ['HTTPS://Status.Example.COM:443/', 'http://Cms.Test:80']
    for (const baseUrl of ['https://status.example.com/x', 'https://STATUS.example.com:443', 'http://cms.test/', 'http://cms.test:80/api']) {
      expect(selectFromBlock({ baseUrl }, { allowedOrigins: list }), baseUrl).toMatchObject({ ok: true })
    }
    expect(selectFromBlock({ baseUrl: 'http://cms.test:8080' }, { allowedOrigins: list })).toMatchObject({ ok: false })
  })

  it('still refuses credentials, a query or a fragment on an allowed origin', () => {
    for (const baseUrl of ['https://u:p@status.example.com', 'https://status.example.com/?x=1', 'https://status.example.com/#top']) {
      expect(selectFromBlock({ baseUrl }, { allowedOrigins }), baseUrl).toMatchObject({ ok: false, reason: expect.stringMatching(/credentials|query string or a fragment/) })
    }
  })

  it('refuses every block, naming the entry, when a configured entry is not an http(s) origin', () => {
    for (const bad of ['status.example.com', 'ftp://status.example.com', 'https://status.example.com/prefix', 'https://u@status.example.com', 'https://status.example.com/?x', 'https://status.example.com#']) {
      expect(selectFromBlock({ baseUrl: 'https://status.example.com' }, { allowedOrigins: ['https://status.example.com', bad] }), bad).toEqual({
        ok: false,
        reason: `allowedOrigins entry ${JSON.stringify(bad)} must be an http(s) origin such as https://status.example.com`,
      })
    }
  })
})

describe('parseAllowedOrigins', () => {
  it('normalises each entry to its origin', () => {
    expect(parseAllowedOrigins([' https://Status.Example.com:443/ ', 'http://cms.test:8080'])).toEqual({ ok: true, origins: ['https://status.example.com', 'http://cms.test:8080'] })
  })

  it('reports a non-array or non-string entry', () => {
    expect(parseAllowedOrigins('https://status.example.com')).toMatchObject({ ok: false, reason: 'allowedOrigins must be an array of origins' })
    expect(parseAllowedOrigins([42])).toMatchObject({ ok: false, reason: expect.stringContaining('allowedOrigins entry 42') })
  })
})

describe('blockFetchOptions', () => {
  it('does not follow a redirect, so an accepted source cannot send the read elsewhere', async () => {
    const seen: Array<RequestRedirect | undefined> = []
    const redirecting = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect)
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/api/status.json' } })
    }) as typeof fetch
    const result = await fetchStatus({ baseUrl: 'https://status.example.com' }, blockFetchOptions(redirecting))
    expect(seen).toEqual(['manual'])
    expect(result).toMatchObject({ ok: false, reason: 'http', detail: 'HTTP 302' })
  })
})
