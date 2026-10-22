import { describe, expect, it } from 'bun:test'
import { selectFromBlock } from './block-node'

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
