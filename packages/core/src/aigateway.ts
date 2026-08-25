import type { FetchLike } from './check'
import type { AigatewayConfig, AigatewayProvider, Site } from './config'
import type { CheckResult, CheckStatus } from './types'
import { z } from 'zod'

/**
 * API roots of the two supported model gateways. Both publish their endpoint
 * health unauthenticated, so no token is needed (and none is sent).
 */
export const AIGATEWAY_BASE_URL: Record<AigatewayProvider, string> = {
  vercel: 'https://ai-gateway.vercel.sh/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

/**
 * A published latency sample. Vercel reports an object of percentiles
 * (`{ p50, p95 }`); a bare number is accepted as the p50 so a flattened shape
 * still grades. `null` is routine, not exceptional — OpenRouter currently
 * publishes no latency at all on the public endpoint.
 */
export const aigatewayLatencySchema = z
  .union([z.number(), z.object({ p50: z.number().optional(), p95: z.number().optional() })])
  .nullish()

export type AigatewayLatency = z.infer<typeof aigatewayLatencySchema>

/**
 * One routed endpoint (a provider serving the model) as published by either
 * gateway. Every field is optional or nullable: the two gateways expose
 * different window keys (Vercel `15m`/`1h`, OpenRouter `5m`/`30m`) and null out
 * any window they have no traffic for.
 */
export const aigatewayEndpointSchema = z.object({
  /** e.g. `anthropic | anthropic/claude-opus-4.5` — the provider label plus the routed model. */
  name: z.string().optional(),
  /** e.g. `anthropic` (Vercel) or `Amazon Bedrock` (OpenRouter). Not unique on OpenRouter. */
  provider_name: z.string().optional(),
  /** OpenRouter only: the stable, unique endpoint id, e.g. `amazon-bedrock/eu-west-1`. */
  tag: z.string().optional(),
  /** Undocumented health code: `0` is healthy, negative values mean deranked/disabled. */
  status: z.number().nullish(),
  uptime_last_5m: z.number().nullish(),
  uptime_last_15m: z.number().nullish(),
  uptime_last_30m: z.number().nullish(),
  uptime_last_1h: z.number().nullish(),
  uptime_last_1d: z.number().nullish(),
  latency_last_30m: aigatewayLatencySchema,
  latency_last_1h: aigatewayLatencySchema,
})

export type AigatewayEndpoint = z.infer<typeof aigatewayEndpointSchema>

/**
 * The slice of `GET …/models/{creator}/{model}/endpoints` we rely on, validated
 * at the boundary like the Statuspage and Sentry payloads: a wrong-shaped body
 * (an error page, an API change, a non-object) is reported rather than graded.
 * `data.endpoints` is required — a body without it is not this payload at all,
 * which is a different failure from a model that legitimately lists none.
 */
export const aigatewayEndpointsSchema = z.object({
  data: z.object({
    id: z.string().optional(),
    endpoints: z.array(aigatewayEndpointSchema),
  }),
})

export type AigatewayEndpoints = z.infer<typeof aigatewayEndpointsSchema>

/** Resolved telemetry for one endpoint, with the windows the numbers cover. */
export interface AigatewaySample {
  /** Published uptime percentage (0..100); absent when the gateway published none. */
  uptime?: number
  /** Window `uptime` covers (`1h`, `30m`, …); absent together with `uptime`. */
  uptimeWindow?: string
  /** Published median latency in ms; absent when the gateway published none. */
  latencyP50?: number
  /** Window a latency sample covers, whether or not one was published. */
  latencyWindow: string
}

/** `up` beats `degraded` beats `down` when rolling several endpoints into one verdict. */
const AIGATEWAY_STATUS_RANK: Record<CheckStatus, number> = { up: 2, degraded: 1, down: 0 }

/**
 * Build the endpoints URL for a `check: aigateway` site. The model id is a
 * `creator/model` pair, so it is split and each segment encoded separately —
 * encoding the whole id would escape the separating slash into `%2F`.
 */
export function aigatewayEndpointsUrl(cfg: AigatewayConfig): string {
  const path = cfg.model.split('/').map(encodeURIComponent).join('/')
  return `${AIGATEWAY_BASE_URL[cfg.provider]}/models/${path}/endpoints`
}

/**
 * Narrow the published endpoints to the one a site tracks. Without an `endpoint`
 * the whole list is returned and the model is graded across all of them. With
 * one, matching is case-insensitive and tried in precedence order: `tag` (stable
 * and unique on OpenRouter), then `provider_name`, then the full `name`. Throws
 * when nothing matches so the caller records `down` with a clear error, the same
 * way {@link ./check.deriveStatuspageStatus} handles a missing component.
 */
export function selectAigatewayEndpoint(endpoints: AigatewayEndpoint[], endpoint?: string): AigatewayEndpoint[] {
  if (endpoint === undefined) {
    return endpoints
  }
  const target = endpoint.trim().toLowerCase()
  const matches = (value: string | undefined): boolean => value?.trim().toLowerCase() === target
  const found
    = endpoints.find(e => matches(e.tag))
      ?? endpoints.find(e => matches(e.provider_name))
      ?? endpoints.find(e => matches(e.name))
  if (!found) {
    throw new Error(`AI Gateway endpoint not found: ${endpoint}`)
  }
  return [found]
}

/** Read a latency field's p50, treating a bare number as the p50 itself. */
function latencyP50(latency: AigatewayLatency): number | undefined {
  const value = typeof latency === 'number' ? latency : latency?.p50
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve one endpoint's telemetry for the given gateway. The two aggregate over
 * different windows, so the window that produced each number is carried along
 * (and surfaced in the adapter docs) rather than silently compared: Vercel's
 * uptime is hourly, OpenRouter's half-hourly. Within a gateway that headline
 * aggregate is the primary window — the same window the latency figure covers,
 * so one CheckResult describes one time slice rather than two. Only when the
 * gateway published `null` there is a shorter window tried, then `1d`,
 * preferring a stale-but-real number over none. In practice an endpoint idle
 * enough to null the primary window has usually nulled the shorter one too, so
 * the realistic fallback is straight to `1d`.
 */
export function aigatewaySample(endpoint: AigatewayEndpoint, provider: AigatewayProvider): AigatewaySample {
  const windows: [number | null | undefined, string][] = provider === 'vercel'
    ? [[endpoint.uptime_last_1h, '1h'], [endpoint.uptime_last_15m, '15m'], [endpoint.uptime_last_1d, '1d']]
    : [[endpoint.uptime_last_30m, '30m'], [endpoint.uptime_last_5m, '5m'], [endpoint.uptime_last_1d, '1d']]
  const sampled = windows.find(([value]) => typeof value === 'number' && Number.isFinite(value))
  return {
    uptime: sampled?.[0] ?? undefined,
    uptimeWindow: sampled?.[1],
    latencyP50: latencyP50(provider === 'vercel' ? endpoint.latency_last_1h : endpoint.latency_last_30m),
    latencyWindow: provider === 'vercel' ? '1h' : '30m',
  }
}

/**
 * Grade one endpoint from its published telemetry.
 *
 * Uptime is the primary signal — it is the one number both gateways document and
 * publish consistently. When the gateway published none for any window, that is
 * silence rather than a verdict, so the weaker signals decide instead.
 *
 * The `status` integer is undocumented (`0` healthy, `-2`/`-5` observed in the
 * wild), so a negative value — the gateway has deranked or disabled the endpoint
 * — only ever yields `degraded`, never `down` on its own. `down` beats
 * `degraded` beats `up`.
 */
export function deriveAigatewayStatus(
  sample: AigatewaySample,
  endpointStatus: number | null | undefined,
  cfg: Pick<AigatewayConfig, 'degradedUptime' | 'downUptime'>,
  maxResponseTime: number,
): CheckStatus {
  if (sample.uptime !== undefined) {
    if (sample.uptime < cfg.downUptime) {
      return 'down'
    }
    if (sample.uptime < cfg.degradedUptime) {
      return 'degraded'
    }
  }
  if (typeof endpointStatus === 'number' && endpointStatus < 0) {
    return 'degraded'
  }
  if (sample.latencyP50 !== undefined && sample.latencyP50 > maxResponseTime) {
    return 'degraded'
  }
  return 'up'
}

/**
 * AI Gateway check: read a model's published endpoint health from the Vercel AI
 * Gateway or OpenRouter and grade it. Both endpoints are unauthenticated, and
 * this runs no probe traffic against the model — no tokens are spent; the
 * gateway's own production telemetry is the source of truth.
 *
 * With `aigateway.endpoint` set, that one provider endpoint is graded. Without
 * it the whole model is graded and the **best** endpoint wins: the gateway
 * routes around a failing provider, so a single bad endpoint is not a model-level
 * outage.
 *
 * `responseTime` is the gateway's published p50 for the model, **not** the
 * round-trip of this API call — grading the gateway's own API latency would be
 * the wrong signal entirely. It is `0` when no latency sample was published
 * (OpenRouter currently publishes `null` on every public response) and on every
 * failure path, and latency then plays no part in the verdict.
 */
export async function checkAigateway(
  site: Site,
  deps: { fetchImpl?: FetchLike, now?: () => number } = {},
): Promise<CheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const start = now()
  const checkedAt = new Date(start).toISOString()
  const cfg = site.aigateway

  if (!cfg) {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: 0,
      checkedAt,
      error: 'AI Gateway check not configured (needs site.aigateway.provider and site.aigateway.model)',
    }
  }

  const url = aigatewayEndpointsUrl(cfg)

  // Every failure path below reports `responseTime: 0`: this adapter's response
  // time is the *published* model latency, and a failed check has none. Timing
  // the gateway's own API instead would inject its round-trip (tens of ms) into
  // a series that otherwise holds model latencies (hundreds to thousands),
  // because ingest persists `response_time` for down results too.
  //
  // Phase 1: the network round-trip. A throw means the request never completed,
  // so `code: 0` is the honest signal (per CheckResult.code).
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      // Cap the round-trip so a slow/hung gateway API can't stall the cron tick;
      // a timeout throws and is caught below as `code: 0` down, like any other
      // network failure.
      signal: AbortSignal.timeout(10000),
    })
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: 0,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!res.ok) {
    return { slug: site.slug, status: 'down', code: res.status, responseTime: 0, checkedAt, error: `AI Gateway API returned ${res.status}` }
  }

  // Phase 2: parse and grade. The request completed, so preserve the real HTTP
  // status in `code` — a payload/config problem (unknown endpoint name, changed
  // schema) is deterministic and distinct from a network outage, and collapsing
  // it to `code: 0` would make a persistent misconfiguration look like flakiness
  // in the persisted history.
  try {
    const parsed = aigatewayEndpointsSchema.safeParse(await res.json())
    if (!parsed.success) {
      return { slug: site.slug, status: 'down', code: res.status, responseTime: 0, checkedAt, error: `AI Gateway endpoints payload failed validation: ${parsed.error.message}` }
    }
    const endpoints = selectAigatewayEndpoint(parsed.data.data.endpoints, cfg.endpoint)
    if (endpoints.length === 0) {
      return { slug: site.slug, status: 'down', code: res.status, responseTime: 0, checkedAt, error: `AI Gateway model publishes no endpoints: ${cfg.model}` }
    }
    const graded = endpoints.map((endpoint) => {
      const sample = aigatewaySample(endpoint, cfg.provider)
      return { sample, status: deriveAigatewayStatus(sample, endpoint.status, cfg, site.maxResponseTime) }
    })
    const best = graded.reduce((a, b) => {
      const delta = AIGATEWAY_STATUS_RANK[b.status] - AIGATEWAY_STATUS_RANK[a.status]
      if (delta > 0) {
        return b
      }
      // Among endpoints tied at the best status, prefer one that published a
      // latency sample. The gateway lists endpoints in its own order, and an
      // idle endpoint with null telemetry is often listed first (Vercel lists
      // `azure` before `openai` for `openai/gpt-5`), which would otherwise
      // report `0` while a healthy sibling has a real p50.
      if (delta === 0 && a.sample.latencyP50 === undefined && b.sample.latencyP50 !== undefined) {
        return b
      }
      return a
    })
    return {
      slug: site.slug,
      status: best.status,
      code: res.status,
      // Round: the persisted `response_time` column is an INTEGER, and gateways
      // publish fractional milliseconds.
      responseTime: Math.round(best.sample.latencyP50 ?? 0),
      checkedAt,
    }
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: res.status,
      responseTime: 0,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
