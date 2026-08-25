import type { AigatewayEndpoint } from './aigateway'
import type { FetchLike } from './check'
import { describe, expect, it } from 'bun:test'
import {
  aigatewayEndpointsSchema,
  aigatewayEndpointsUrl,
  aigatewaySample,
  checkAigateway,
  deriveAigatewayStatus,
  selectAigatewayEndpoint,
} from './aigateway'
import { siteSchema } from './config'

/** A `check: aigateway` site reading a whole model on the Vercel AI Gateway. */
const vercelSite = siteSchema.parse({
  name: 'Claude Opus 4.5',
  check: 'aigateway',
  aigateway: { provider: 'vercel', model: 'anthropic/claude-opus-4.5' },
})

/** The same model on OpenRouter, narrowed to one endpoint by its tag. */
const openrouterSite = siteSchema.parse({
  name: 'Claude Opus 4.5 (Bedrock)',
  check: 'aigateway',
  aigateway: { provider: 'openrouter', model: 'anthropic/claude-opus-4.5', endpoint: 'amazon-bedrock' },
})

/** Shaped like a real `ai-gateway.vercel.sh` endpoints response. */
const vercelPayload = {
  data: {
    id: 'anthropic/claude-opus-4.5',
    endpoints: [
      {
        name: 'anthropic | anthropic/claude-opus-4.5',
        provider_name: 'anthropic',
        status: 0,
        uptime_last_15m: 100,
        uptime_last_1h: 100,
        uptime_last_1d: 99.9834,
        latency_last_1h: { p50: 814, p95: 1673.6999999999975 },
        throughput_last_1h: { p50: 50.5, p95: 51.85 },
      },
      {
        name: 'bedrock | anthropic/claude-opus-4.5',
        provider_name: 'bedrock',
        status: 0,
        uptime_last_15m: 100,
        uptime_last_1h: 100,
        uptime_last_1d: 100,
        latency_last_1h: { p50: 1425, p95: 1975 },
        throughput_last_1h: { p50: 48.5, p95: 51.7 },
      },
    ],
  },
}

/** Shaped like a real `openrouter.ai` endpoints response — latency is null throughout. */
const openrouterPayload = {
  data: {
    id: 'anthropic/claude-opus-4.5',
    endpoints: [
      {
        name: 'Anthropic | anthropic/claude-4.5-opus-20251124',
        provider_name: 'Anthropic',
        tag: 'anthropic',
        status: 0,
        uptime_last_5m: null,
        uptime_last_30m: 100,
        uptime_last_1d: 99.98480632816432,
        latency_last_30m: null,
        throughput_last_30m: null,
      },
      {
        name: 'Amazon Bedrock | anthropic/claude-4.5-opus-20251124',
        provider_name: 'Amazon Bedrock',
        tag: 'amazon-bedrock',
        status: 0,
        uptime_last_5m: 100,
        uptime_last_30m: 99.6299037749815,
        uptime_last_1d: 99.91697276042323,
        latency_last_30m: null,
        throughput_last_30m: null,
      },
    ],
  },
}

/** Resolve to a gateway API response with the given JSON body. */
function endpointsResponse(body: unknown, status = 200): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

const [vercelAnthropic, vercelBedrock] = vercelPayload.data.endpoints as AigatewayEndpoint[]
const [openrouterAnthropic, openrouterBedrock] = openrouterPayload.data.endpoints as AigatewayEndpoint[]

describe('aigatewayEndpointsUrl', () => {
  it('builds the Vercel AI Gateway endpoints URL', () => {
    expect(aigatewayEndpointsUrl({ provider: 'vercel', model: 'anthropic/claude-opus-4.5', degradedUptime: 99, downUptime: 50 }))
      .toBe('https://ai-gateway.vercel.sh/v1/models/anthropic/claude-opus-4.5/endpoints')
  })

  it('builds the OpenRouter endpoints URL', () => {
    expect(aigatewayEndpointsUrl({ provider: 'openrouter', model: 'anthropic/claude-opus-4.5', degradedUptime: 99, downUptime: 50 }))
      .toBe('https://openrouter.ai/api/v1/models/anthropic/claude-opus-4.5/endpoints')
  })

  it('encodes each model segment but keeps the creator/model separator', () => {
    expect(aigatewayEndpointsUrl({ provider: 'openrouter', model: 'openai/gpt-oss-120b:free', degradedUptime: 99, downUptime: 50 }))
      .toBe('https://openrouter.ai/api/v1/models/openai/gpt-oss-120b%3Afree/endpoints')
  })
})

describe('aigatewayEndpointsSchema', () => {
  it('accepts both providers\' real payload shapes', () => {
    expect(aigatewayEndpointsSchema.safeParse(vercelPayload).success).toBe(true)
    expect(aigatewayEndpointsSchema.safeParse(openrouterPayload).success).toBe(true)
  })

  it('accepts a bare number latency and an empty endpoints list', () => {
    const parsed = aigatewayEndpointsSchema.safeParse({ data: { endpoints: [{ latency_last_1h: 900 }] } })
    expect(parsed.success).toBe(true)
    expect(aigatewayEndpointsSchema.safeParse({ data: { endpoints: [] } }).success).toBe(true)
  })

  it('rejects a non-object body and a body without endpoints', () => {
    expect(aigatewayEndpointsSchema.safeParse('nope').success).toBe(false)
    expect(aigatewayEndpointsSchema.safeParse({ error: { message: 'not found' } }).success).toBe(false)
    expect(aigatewayEndpointsSchema.safeParse({ data: { id: 'anthropic/claude-opus-4.5' } }).success).toBe(false)
  })
})

describe('selectAigatewayEndpoint', () => {
  const endpoints = openrouterPayload.data.endpoints as AigatewayEndpoint[]

  it('returns every endpoint when none is named', () => {
    expect(selectAigatewayEndpoint(endpoints)).toHaveLength(2)
  })

  it('matches by tag first', () => {
    expect(selectAigatewayEndpoint(endpoints, 'amazon-bedrock')[0]?.tag).toBe('amazon-bedrock')
  })

  it('falls back to provider_name, case-insensitively and trimmed', () => {
    expect(selectAigatewayEndpoint(endpoints, '  amazon bedrock  ')[0]?.tag).toBe('amazon-bedrock')
    expect(selectAigatewayEndpoint(vercelPayload.data.endpoints as AigatewayEndpoint[], 'BEDROCK')[0]?.provider_name)
      .toBe('bedrock')
  })

  it('falls back to the full endpoint name', () => {
    expect(selectAigatewayEndpoint(endpoints, 'Anthropic | anthropic/claude-4.5-opus-20251124')[0]?.tag)
      .toBe('anthropic')
  })

  it('prefers a tag match over a provider_name match on the same string', () => {
    const ambiguous: AigatewayEndpoint[] = [
      { provider_name: 'anthropic', tag: 'vertex' },
      { provider_name: 'vertex', tag: 'anthropic' },
    ]
    expect(selectAigatewayEndpoint(ambiguous, 'anthropic')[0]?.tag).toBe('anthropic')
  })

  it('throws when the named endpoint is missing', () => {
    expect(() => selectAigatewayEndpoint(endpoints, 'groq')).toThrow(/not found/)
  })
})

describe('aigatewaySample', () => {
  it('reads the 1h window and the p50 object for vercel', () => {
    expect(aigatewaySample(vercelAnthropic!, 'vercel')).toEqual({
      uptime: 100,
      uptimeWindow: '1h',
      latencyP50: 814,
      latencyWindow: '1h',
    })
  })

  it('reads the 30m window for openrouter and reports no latency', () => {
    expect(aigatewaySample(openrouterBedrock!, 'openrouter')).toEqual({
      uptime: 99.6299037749815,
      uptimeWindow: '30m',
      latencyP50: undefined,
      latencyWindow: '30m',
    })
  })

  it('falls back through the narrower windows to 1d when they are null', () => {
    const vercel = aigatewaySample({ uptime_last_1h: null, uptime_last_15m: 98, uptime_last_1d: 99 }, 'vercel')
    expect(vercel.uptime).toBe(98)
    expect(vercel.uptimeWindow).toBe('15m')

    const openrouter = aigatewaySample({ uptime_last_30m: null, uptime_last_5m: null, uptime_last_1d: 89.2 }, 'openrouter')
    expect(openrouter.uptime).toBe(89.2)
    expect(openrouter.uptimeWindow).toBe('1d')
  })

  it('leaves uptime undefined when the gateway published no window', () => {
    const sample = aigatewaySample({ uptime_last_30m: null, uptime_last_5m: null, uptime_last_1d: null }, 'openrouter')
    expect(sample.uptime).toBeUndefined()
    expect(sample.uptimeWindow).toBeUndefined()
  })

  it('accepts a bare number latency as the p50 and ignores a null one', () => {
    expect(aigatewaySample({ latency_last_1h: 940 }, 'vercel').latencyP50).toBe(940)
    expect(aigatewaySample({ latency_last_30m: { p95: 1800 } }, 'openrouter').latencyP50).toBeUndefined()
    expect(aigatewaySample({ latency_last_1h: null }, 'vercel').latencyP50).toBeUndefined()
  })
})

describe('deriveAigatewayStatus', () => {
  const cfg = { degradedUptime: 99, downUptime: 50 }
  const window = { uptimeWindow: '1h', latencyWindow: '1h' }

  it('is up for healthy uptime, a zero status, and fast latency', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 100, latencyP50: 814 }, 0, cfg, 5000)).toBe('up')
  })

  it('is down below downUptime', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 12 }, 0, cfg, 5000)).toBe('down')
  })

  it('is degraded between downUptime and degradedUptime', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 98.4 }, 0, cfg, 5000)).toBe('degraded')
  })

  it('is degraded for a negative endpoint status, never down', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, -2, cfg, 5000)).toBe('degraded')
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, -5, cfg, 5000)).toBe('degraded')
  })

  // The `status` integer is undocumented, so only `0` is evidence of health. An
  // unrecognized positive code must not read as operational just because we have
  // never seen it.
  it('is degraded for an unknown non-zero endpoint status', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, 1, cfg, 5000)).toBe('degraded')
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, 3, cfg, 5000)).toBe('degraded')
  })

  it('ignores a missing endpoint status rather than treating it as unhealthy', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, null, cfg, 5000)).toBe('up')
    expect(deriveAigatewayStatus({ ...window, uptime: 100 }, undefined, cfg, 5000)).toBe('up')
  })

  it('is degraded when the published p50 exceeds maxResponseTime', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 100, latencyP50: 6000 }, 0, cfg, 5000)).toBe('degraded')
  })

  it('falls through to the status and latency rules when no uptime was published', () => {
    expect(deriveAigatewayStatus({ latencyWindow: '30m' }, 0, cfg, 5000)).toBe('up')
    expect(deriveAigatewayStatus({ latencyWindow: '30m' }, -2, cfg, 5000)).toBe('degraded')
    expect(deriveAigatewayStatus({ latencyWindow: '30m', latencyP50: 9000 }, null, cfg, 5000)).toBe('degraded')
  })

  it('lets down win over a degrading status or latency', () => {
    expect(deriveAigatewayStatus({ ...window, uptime: 10, latencyP50: 9000 }, -2, cfg, 5000)).toBe('down')
  })
})

describe('checkAigateway', () => {
  it('reports up with the published p50 as the response time', async () => {
    const result = await checkAigateway(vercelSite, { fetchImpl: endpointsResponse(vercelPayload), now: () => 0 })
    expect(result.status).toBe('up')
    expect(result.code).toBe(200)
    expect(result.slug).toBe('claude-opus-4-5')
    // The best-graded endpoint's p50, not the round-trip of the gateway call.
    expect(result.responseTime).toBe(814)
    expect(result.error).toBeUndefined()
  })

  it('requests the endpoints URL for the configured provider and model', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = (url) => {
      seen.push(url)
      return Promise.resolve(new Response(JSON.stringify(openrouterPayload), { status: 200 }))
    }
    await checkAigateway(openrouterSite, { fetchImpl, now: () => 0 })
    expect(seen[0]).toBe('https://openrouter.ai/api/v1/models/anthropic/claude-opus-4.5/endpoints')
  })

  it('reports 0 response time when the gateway publishes no latency', async () => {
    const result = await checkAigateway(openrouterSite, { fetchImpl: endpointsResponse(openrouterPayload), now: () => 0 })
    expect(result.status).toBe('up')
    expect(result.responseTime).toBe(0)
  })

  it('grades the whole model by its best endpoint', async () => {
    const payload = {
      data: {
        id: 'anthropic/claude-opus-4.5',
        endpoints: [
          { ...vercelAnthropic, uptime_last_1h: 4, latency_last_1h: { p50: 30000 } },
          vercelBedrock,
        ],
      },
    }
    const result = await checkAigateway(vercelSite, { fetchImpl: endpointsResponse(payload), now: () => 0 })
    expect(result.status).toBe('up')
    // The response time follows the endpoint that won, not the failing one.
    expect(result.responseTime).toBe(1425)
  })

  it('prefers a tied endpoint that published a latency sample', async () => {
    // Shaped like Vercel's `openai/gpt-5`: an idle `azure` endpoint with null
    // telemetry is listed before the `openai` one that actually has a p50. Both
    // grade `up`, so the tie-break decides which latency is reported.
    const payload = {
      data: {
        id: 'openai/gpt-5',
        endpoints: [
          {
            name: 'azure | openai/gpt-5',
            provider_name: 'azure',
            status: 0,
            uptime_last_15m: null,
            uptime_last_1h: null,
            uptime_last_1d: null,
            latency_last_1h: null,
          },
          {
            name: 'openai | openai/gpt-5',
            provider_name: 'openai',
            status: 0,
            uptime_last_15m: 100,
            uptime_last_1h: 100,
            uptime_last_1d: 99.9519,
            latency_last_1h: { p50: 1740, p95: 2129.0499999999997 },
          },
        ],
      },
    }
    const result = await checkAigateway(vercelSite, { fetchImpl: endpointsResponse(payload), now: () => 0 })
    expect(result.status).toBe('up')
    expect(result.responseTime).toBe(1740)
  })

  it('keeps the best status when a worse endpoint is the one with latency', async () => {
    const payload = {
      data: {
        endpoints: [
          { ...vercelAnthropic, uptime_last_1h: 100, latency_last_1h: null },
          { ...vercelBedrock, uptime_last_1h: 20, latency_last_1h: { p50: 1425 } },
        ],
      },
    }
    const result = await checkAigateway(vercelSite, { fetchImpl: endpointsResponse(payload), now: () => 0 })
    // The `down` endpoint has the only p50, but it never wins the tie-break —
    // it isn't tied.
    expect(result.status).toBe('up')
    expect(result.responseTime).toBe(0)
  })

  it('reports down when every endpoint is down', async () => {
    const payload = {
      data: { endpoints: vercelPayload.data.endpoints.map(e => ({ ...e, uptime_last_1h: 10 })) },
    }
    const result = await checkAigateway(vercelSite, { fetchImpl: endpointsResponse(payload), now: () => 0 })
    expect(result.status).toBe('down')
    expect(result.error).toBeUndefined()
  })

  it('grades only the named endpoint', async () => {
    const payload = {
      data: {
        endpoints: [
          { ...openrouterAnthropic, uptime_last_30m: 100 },
          { ...openrouterBedrock, uptime_last_30m: 20 },
        ],
      },
    }
    const result = await checkAigateway(openrouterSite, { fetchImpl: endpointsResponse(payload), now: () => 0 })
    expect(result.status).toBe('down')
  })

  it('reports down when the named endpoint is not published', async () => {
    const site = siteSchema.parse({
      name: 'Opus on Groq',
      check: 'aigateway',
      aigateway: { provider: 'openrouter', model: 'anthropic/claude-opus-4.5', endpoint: 'groq' },
    })
    const result = await checkAigateway(site, { fetchImpl: endpointsResponse(openrouterPayload), now: () => 0 })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toContain('endpoint not found: groq')
  })

  it('reports down when the model publishes no endpoints', async () => {
    const result = await checkAigateway(vercelSite, {
      fetchImpl: endpointsResponse({ data: { id: 'anthropic/claude-opus-4.5', endpoints: [] } }),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.error).toContain('publishes no endpoints')
  })

  it('reports down with code 0 when the request throws', async () => {
    // An advancing clock: the round-trip is deliberately *not* reported — this
    // adapter's response time is the published model latency, and a failed
    // check has none.
    let t = 0
    const result = await checkAigateway(vercelSite, {
      fetchImpl: () => Promise.reject(new Error('network')),
      now: () => (t += 120),
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(0)
    expect(result.responseTime).toBe(0)
    expect(result.error).toBe('network')
  })

  it('reports down preserving the real HTTP code for an unknown model', async () => {
    let t = 0
    const result = await checkAigateway(vercelSite, {
      fetchImpl: endpointsResponse({ error: { message: 'model not found' } }, 404),
      now: () => (t += 120),
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(404)
    expect(result.responseTime).toBe(0)
    expect(result.error).toContain('404')
  })

  it('reports down when the payload is the wrong shape', async () => {
    const result = await checkAigateway(vercelSite, {
      fetchImpl: endpointsResponse({ data: { id: 'anthropic/claude-opus-4.5' } }),
      now: () => 0,
    })
    expect(result.status).toBe('down')
    expect(result.code).toBe(200)
    expect(result.error).toContain('validation')
  })

  it('reports down without hitting the network when the aigateway block is missing', async () => {
    let called = false
    const site = siteSchema.parse({ name: 'Example', url: 'https://example.com' })
    const result = await checkAigateway(site, {
      fetchImpl: () => {
        called = true
        return Promise.resolve(new Response('{}'))
      },
      now: () => 0,
    })
    expect(called).toBe(false)
    expect(result.status).toBe('down')
    expect(result.code).toBe(0)
    expect(result.error).toContain('not configured')
  })
})
