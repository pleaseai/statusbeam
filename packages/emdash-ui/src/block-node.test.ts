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
})
