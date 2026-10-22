import { describe, expect, it } from 'bun:test'
import { checkSite } from './check'
import { siteSchema } from './config'

const site = siteSchema.parse({ name: 'Example', url: 'https://example.com' })
const bodyLimit = (error: unknown) => (error instanceof Error && error.message.includes('body exceeds') ? 'body' as const : undefined)

describe('checkSite host limit classifier', () => {
  it('carries limit "body" when the injected classifier recognises the thrown error', async () => {
    const result = await checkSite(site, {
      fetchImpl: () => Promise.reject(new Error('response body exceeds the limit')),
      classifyError: bodyLimit,
      now: () => 0,
    })
    expect(result).toMatchObject({ status: 'down', code: 0, limit: 'body' })
  })

  it('leaves an unrecognised failure, and every call without a classifier, without a limit field', async () => {
    const classified = await checkSite(site, { fetchImpl: () => Promise.reject(new Error('network')), classifyError: bodyLimit, now: () => 0 })
    const plain = await checkSite(site, { fetchImpl: () => Promise.reject(new Error('response body exceeds the limit')), now: () => 0 })
    expect('limit' in classified).toBe(false)
    expect('limit' in plain).toBe(false)
  })

  it('carries the limit for a statuspage fetch that throws too', async () => {
    const page = siteSchema.parse({ name: 'Claude', url: 'https://status.claude.com', check: 'statuspage' })
    const result = await checkSite(page, {
      fetchImpl: () => Promise.reject(new Error('response body exceeds the limit')),
      classifyError: bodyLimit,
      now: () => 0,
    })
    expect(result.limit).toBe('body')
  })

  it('carries the limit for a sentry poll and an aigateway fetch that throw, and only when classified', async () => {
    const sentry = siteSchema.parse({ name: 'API', url: 'https://api.example.com', check: 'sentry', sentry: { org: 'acme' } })
    const gateway = siteSchema.parse({ name: 'Model', check: 'aigateway', aigateway: { provider: 'vercel', model: 'anthropic/claude-opus-4.5' } })
    for (const target of [sentry, gateway]) {
      const classified = await checkSite(target, {
        fetchImpl: () => Promise.reject(new Error('response body exceeds the limit')),
        classifyError: bodyLimit,
        sentryToken: 'tok',
        now: () => 0,
      })
      const unclassified = await checkSite(target, {
        fetchImpl: () => Promise.reject(new Error('network')),
        classifyError: bodyLimit,
        sentryToken: 'tok',
        now: () => 0,
      })
      expect(classified, target.check).toMatchObject({ status: 'down', code: 0, limit: 'body' })
      expect('limit' in unclassified, target.check).toBe(false)
    }
  })
})
