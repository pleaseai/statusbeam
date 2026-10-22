import { describe, expect, it } from 'bun:test'
import { selectPollSites } from './poll'

const sites = [
  { slug: 'web', check: 'http' as const },
  { slug: 'hook-only', check: 'sentry' as const },
  { slug: 'polled', check: 'sentry' as const, sentry: { org: 'acme' } },
]

describe('selectPollSites', () => {
  it('skips webhook-only sentry sites quietly', () => {
    const warnings: string[] = []
    const picked = selectPollSites(sites, { sentryToken: 'tok', warn: m => warnings.push(m) })
    expect(picked.map(s => s.slug)).toEqual(['web', 'polled'])
    expect(warnings).toEqual([])
  })

  it('skips sentry poll sites with a warning when there is no token', () => {
    const warnings: string[] = []
    const picked = selectPollSites(sites, { warn: m => warnings.push(m) })
    expect(picked.map(s => s.slug)).toEqual(['web'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"polled"')
  })

  it('treats a whitespace-only token as missing', () => {
    for (const sentryToken of ['', ' ', '\t\n ']) {
      const warnings: string[] = []
      const picked = selectPollSites(sites, { sentryToken, warn: m => warnings.push(m) })
      expect(picked.map(s => s.slug), JSON.stringify(sentryToken)).toEqual(['web'])
      expect(warnings).toHaveLength(1)
    }
  })
})
