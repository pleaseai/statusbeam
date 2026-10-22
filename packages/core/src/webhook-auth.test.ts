import { describe, expect, it } from 'bun:test'
import { gradeWebhookPayload, parseWebhookPath, timingSafeEqual, webhookProviderMatchesSite } from './webhook-auth'

describe('parseWebhookPath', () => {
  it('matches supported providers and ignores a trailing slash', () => {
    expect(parseWebhookPath('/webhooks/sentry/api/')).toEqual({ provider: 'sentry', slug: 'api' })
    expect(parseWebhookPath('/webhooks/statuspage/x')).toEqual({ provider: 'statuspage', slug: 'x' })
  })

  it('rejects unknown providers and wrong shapes', () => {
    expect(parseWebhookPath('/webhooks/other/x')).toBeNull()
    expect(parseWebhookPath('/webhooks/sentry')).toBeNull()
  })
})

describe('timingSafeEqual', () => {
  it('compares equal strings, differing strings and length mismatches', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('webhookProviderMatchesSite', () => {
  it('accepts statuspage and incidentio sites on the statuspage route only', () => {
    expect(webhookProviderMatchesSite('statuspage', { check: 'statuspage' })).toBe(true)
    expect(webhookProviderMatchesSite('statuspage', { check: 'incidentio' })).toBe(true)
    expect(webhookProviderMatchesSite('statuspage', { check: 'http' })).toBe(false)
    expect(webhookProviderMatchesSite('sentry', { check: 'incidentio' })).toBe(false)
  })

  it('requires an exact match for sentry and rejects a missing site', () => {
    expect(webhookProviderMatchesSite('sentry', { check: 'sentry' })).toBe(true)
    expect(webhookProviderMatchesSite('sentry', undefined)).toBe(false)
  })
})

describe('gradeWebhookPayload', () => {
  it('reports a wrong-shaped sentry payload as an error with the reason', () => {
    const graded = gradeWebhookPayload('sentry', { action: 42 }, {})
    expect('error' in graded && graded.error).toBe('invalid-payload')
    expect('error' in graded && graded.reason.length).toBeGreaterThan(0)
  })

  it('reports a wrong-shaped statuspage payload as an error', () => {
    expect('error' in gradeWebhookPayload('statuspage', 'not an object', {})).toBe(true)
  })
})
