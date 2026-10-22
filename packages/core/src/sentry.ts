import type { FetchLike } from './check'
import type { Site } from './config'
import type { ErrorClassifier } from './limit'
import type { CheckResult } from './types'
import { z } from 'zod'
import { limitOf } from './limit'

/** Default Sentry SaaS API host; override per-site via `sentry.host` for a region or self-hosted install. */
export const DEFAULT_SENTRY_HOST = 'https://sentry.io'

/**
 * Default issue search used by the poll backstop. Sentry Uptime failures open an
 * issue in the `outage` category; an unresolved match means the monitor is down.
 * Narrow it per-site with `sentry.query` when a project has several monitors.
 */
export const DEFAULT_SENTRY_QUERY = 'is:unresolved issue.category:outage'

/**
 * The slice of Sentry's `GET …/issues/` response we rely on: a JSON array of
 * issues. Validated at the boundary (like the Statuspage adapter) so a
 * wrong-shaped body — an auth error page, an API change — is reported rather than
 * graded. Every field is optional; presence of any (unresolved) item is what
 * matters, not its contents.
 */
export const sentryIssuesSchema = z.array(
  z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    title: z.string().optional(),
  }),
)

export type SentryIssues = z.infer<typeof sentryIssuesSchema>

/** Strip trailing slashes with a linear scan (avoids the polynomial-ReDoS `/\/+$/`, matching check.ts). */
function stripTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end--
  }
  return url.slice(0, end)
}

/**
 * Build the Sentry Issues API URL for a `check: sentry` site's poll backstop.
 * `site.sentry` must be set (the caller guarantees it). The query filters to
 * unresolved outage issues (overridable via `sentry.query`) and asks for a single
 * row — we only care whether *any* match exists.
 */
export function sentryIssuesUrl(site: Site): string {
  const cfg = site.sentry
  if (!cfg) {
    throw new Error(`sentryIssuesUrl called for a site without sentry config: ${site.slug}`)
  }
  const host = stripTrailingSlashes(cfg.host ?? DEFAULT_SENTRY_HOST)
  const params = new URLSearchParams({ query: cfg.query ?? DEFAULT_SENTRY_QUERY, limit: '1' })
  if (cfg.project !== undefined) {
    params.set('project', cfg.project)
  }
  return `${host}/api/0/organizations/${encodeURIComponent(cfg.org)}/issues/?${params.toString()}`
}

/**
 * Poll backstop for a `check: sentry` site: read Sentry's Issues API and grade
 * the monitor `down` when an unresolved outage issue exists, `up` otherwise.
 * Sentry publishes no dedicated uptime-status endpoint, so the issue lifecycle is
 * the source of truth — the same lifecycle the webhook path grades in real time
 * ({@link ./sentry-webhook.deriveSentryWebhookStatus}).
 *
 * The token is injected by the caller (the Worker reads it from
 * `SENTRY_AUTH_TOKEN`); it never lives in the KV config, keeping core
 * framework-free and the secret out of the bundle. A missing token or `sentry`
 * block is a deploy/config problem, reported as `down` with `code: 0` and a clear
 * error — but note the Worker's cron loop *skips* webhook-only Sentry sites, so a
 * webhook-only setup is never graded here.
 */
export async function checkSentry(
  site: Site,
  deps: { fetchImpl?: FetchLike, now?: () => number, token?: string, classifyError?: ErrorClassifier } = {},
): Promise<CheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const start = now()
  const checkedAt = new Date(start).toISOString()

  if (!site.sentry || deps.token === undefined || deps.token === '') {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: 0,
      checkedAt,
      error: 'Sentry poll not configured (needs site.sentry.org and SENTRY_AUTH_TOKEN)',
    }
  }

  const url = sentryIssuesUrl(site)

  // Phase 1: the network round-trip. A throw means the request never completed,
  // so `code: 0` is the honest signal (per CheckResult.code).
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${deps.token}` },
      redirect: 'follow',
      // Cap the round-trip so a slow/hung Sentry API can't stall the cron tick
      // (or a Queues consumer) indefinitely; a timeout throws and is caught below
      // as `code: 0` down, the same as any other network failure.
      signal: AbortSignal.timeout(10000),
    })
  }
  catch (err) {
    return {
      slug: site.slug,
      status: 'down',
      code: 0,
      responseTime: now() - start,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
      ...limitOf(deps.classifyError, err),
    }
  }

  const responseTime = now() - start
  if (!res.ok) {
    return { slug: site.slug, status: 'down', code: res.status, responseTime, checkedAt, error: `Sentry API returned ${res.status}` }
  }

  // Phase 2: parse and grade. The request completed, so preserve the real HTTP
  // status in `code` — a payload/auth problem is distinct from a network outage.
  try {
    const parsed = sentryIssuesSchema.safeParse(await res.json())
    if (!parsed.success) {
      return { slug: site.slug, status: 'down', code: res.status, responseTime, checkedAt, error: `Sentry issues payload failed validation: ${parsed.error.message}` }
    }
    // The query already filters `is:unresolved`; treat any returned issue as an
    // active outage. The status re-check is belt-and-suspenders for a custom query.
    const down = parsed.data.some(issue => (issue.status ?? 'unresolved') === 'unresolved')
    return { slug: site.slug, status: down ? 'down' : 'up', code: res.status, responseTime, checkedAt }
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
