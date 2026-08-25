import type { Site } from './config'
import type { CheckResult, CheckStatus } from './types'
import { z } from 'zod'
import { checkAigateway } from './aigateway'
import { checkSentry } from './sentry'

/** Minimal fetch signature so callers (and tests) can pass any compatible impl. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Derive a check status from a completed HTTP response.
 * `up` when the code is expected and fast enough, `degraded` when it is
 * expected but slow, `down` otherwise.
 */
export function deriveStatus(
  code: number,
  responseTime: number,
  site: Pick<Site, 'expectedStatusCodes' | 'maxResponseTime'>,
): CheckStatus {
  if (!site.expectedStatusCodes.includes(code)) {
    return 'down'
  }
  if (responseTime > site.maxResponseTime) {
    return 'degraded'
  }
  return 'up'
}

/**
 * Run one check for a site. Injectable `fetchImpl` and `now` keep this pure and
 * testable; the Worker passes the platform `fetch`.
 *
 * Dispatches on `site.check`: `statuspage` reads an Atlassian Statuspage JSON
 * API, and `incidentio` reads an incident.io status page — which serves a
 * Statuspage-compatible `summary.json`, so it shares the same code path. `sentry`
 * reads a Sentry Uptime monitor's issue state via the Issues API (needs the
 * injected `sentryToken`; see sentry.ts). `aigateway` reads a model's published
 * endpoint health from the Vercel AI Gateway or OpenRouter — telemetry the
 * gateway already collects, so no probe traffic is sent to the model (see
 * aigateway.ts). Every other kind (`http`/`tcp`/`ssl`)
 * currently falls through to a plain HTTP fetch. `tcp`/`ssl` runtime probing is
 * tracked in the roadmap.
 */
export async function checkSite(
  site: Site,
  deps: { fetchImpl?: FetchLike, now?: () => number, sentryToken?: string } = {},
): Promise<CheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  if (site.check === 'statuspage' || site.check === 'incidentio') {
    return checkStatuspage(site, fetchImpl, now)
  }
  if (site.check === 'sentry') {
    return checkSentry(site, { fetchImpl, now, token: deps.sentryToken })
  }
  if (site.check === 'aigateway') {
    return checkAigateway(site, { fetchImpl, now })
  }
  return checkHttp(site, fetchImpl, now)
}

/** Plain HTTP check: fetch the URL and grade by status code and latency. */
async function checkHttp(site: Site, fetchImpl: FetchLike, now: () => number): Promise<CheckResult> {
  const start = now()

  try {
    const res = await fetchImpl(site.url, {
      method: site.method,
      redirect: 'follow',
    })
    const responseTime = now() - start
    return {
      slug: site.slug,
      status: deriveStatus(res.status, responseTime, site),
      code: res.status,
      responseTime,
      checkedAt: new Date(start).toISOString(),
    }
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: now() - start,
      checkedAt: new Date(start).toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Atlassian Statuspage component `status` → our {@link CheckStatus}.
 * Exported so the webhook mapper ({@link ./statuspage-webhook}) grades pushed
 * component updates with the exact same table the polling adapter uses.
 */
export const STATUSPAGE_COMPONENT_STATUS: Record<string, CheckStatus> = {
  operational: 'up',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'down',
  under_maintenance: 'degraded',
}

/** Atlassian Statuspage overall page `indicator` → our {@link CheckStatus}. */
export const STATUSPAGE_INDICATOR_STATUS: Record<string, CheckStatus> = {
  none: 'up',
  minor: 'degraded',
  major: 'down',
  critical: 'down',
  maintenance: 'degraded',
}

/**
 * The slice of an Atlassian Statuspage `summary.json` payload we rely on.
 * Validated at the boundary rather than trusting a bare type assertion, so a
 * response of the wrong shape (a proxy error page, an API version change, a
 * non-object body) is caught and reported instead of read as a real payload.
 */
export const statuspageSummarySchema = z.object({
  status: z
    .object({
      indicator: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  components: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional(),
})

export type StatuspageSummary = z.infer<typeof statuspageSummarySchema>

/**
 * Resolve the `summary.json` API URL for a configured Statuspage `url`. A bare
 * page URL (`https://status.claude.com`) gets `/api/v2/summary.json` appended;
 * a URL already pointing at an `/api/v2/*.json` endpoint is used verbatim.
 */
export function statuspageSummaryUrl(url: string): string {
  // Strip trailing slashes first, with a linear character scan rather than a
  // backtracking regex (`/\/+$/` is a polynomial-ReDoS pattern on inputs with
  // many trailing slashes — flagged by CodeQL js/polynomial-redos). Testing the
  // cleaned URL against the endpoint pattern also handles an explicit
  // `/api/v2/*.json` URL that carries a trailing slash (otherwise the guard
  // would miss it and produce a doubled `.../summary.json/api/v2/summary.json`).
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end--
  }
  const cleaned = url.slice(0, end)
  if (/\/api\/v2\/[^/]+\.json$/.test(cleaned)) {
    return cleaned
  }
  return `${cleaned}/api/v2/summary.json`
}

/**
 * Grade a Statuspage `summary.json` payload. With a `component` (matched by id
 * or case-insensitive name) the single component's status wins; otherwise the
 * page's overall `indicator` is used. Unknown status strings map to `degraded`
 * (something is off, but not clearly an outage). Throws when a named component
 * isn't present so the caller records it as `down` with a clear error; the
 * `provider` label keeps that message consistent with the other two error
 * strings in {@link checkStatuspage} (e.g. `incident.io` vs `Statuspage`).
 */
export function deriveStatuspageStatus(summary: StatuspageSummary, component?: string, provider = 'Statuspage'): CheckStatus {
  if (component !== undefined) {
    const trimmed = component.trim()
    const target = trimmed.toLowerCase()
    const match = summary.components?.find(
      c => c.id === trimmed || c.name?.trim().toLowerCase() === target,
    )
    if (!match) {
      throw new Error(`${provider} component not found: ${component}`)
    }
    return STATUSPAGE_COMPONENT_STATUS[match.status ?? ''] ?? 'degraded'
  }
  return STATUSPAGE_INDICATOR_STATUS[summary.status?.indicator ?? ''] ?? 'degraded'
}

/**
 * Statuspage check: fetch the page's `summary.json` and map the overall
 * indicator (or a single configured `component`) to a {@link CheckStatus}.
 * Shared by `check: statuspage` and `check: incidentio` — incident.io serves
 * the same Statuspage-compatible payload — with only the error label differing
 * so a user sees the provider they configured. `responseTime` measures the API
 * call, not the monitored service, so it does not affect the verdict — the
 * status comes entirely from the payload.
 */
async function checkStatuspage(site: Site, fetchImpl: FetchLike, now: () => number): Promise<CheckResult> {
  const start = now()
  const url = statuspageSummaryUrl(site.url)
  const checkedAt = new Date(start).toISOString()
  const provider = site.check === 'incidentio' ? 'incident.io' : 'Statuspage'

  // Phase 1: the network round-trip. A throw here means the request never
  // completed, so `code: 0` is the honest signal (per CheckResult.code).
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', redirect: 'follow' })
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: now() - start,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const responseTime = now() - start
  if (!res.ok) {
    return { slug: site.slug, status: 'down', code: res.status, responseTime, checkedAt, error: `${provider} API returned ${res.status}` }
  }

  // Phase 2: parse and grade. The request already completed, so preserve the
  // real HTTP status in `code` — a failure here (malformed body, unknown
  // component) is a payload/config problem, distinct from a network outage,
  // and collapsing it to `code: 0` would make a persistent misconfiguration
  // look like transient flakiness in the persisted history.
  try {
    // Validate the shape at the boundary instead of trusting a type assertion.
    // safeParse also rejects non-objects (null, arrays), so a wrong-shaped body
    // is reported rather than silently graded.
    const parsed = statuspageSummarySchema.safeParse(await res.json())
    if (!parsed.success) {
      return { slug: site.slug, status: 'down', code: res.status, responseTime, checkedAt, error: `${provider} summary.json failed validation: ${parsed.error.message}` }
    }
    return {
      slug: site.slug,
      status: deriveStatuspageStatus(parsed.data, site.component, provider),
      code: res.status,
      responseTime,
      checkedAt,
    }
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: res.status,
      responseTime,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
