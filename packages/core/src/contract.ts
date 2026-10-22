import type { UptimePeriod } from './badge'
import type { SiteSummary } from './types'
import { z } from 'zod'
import { overallSiteSeverity } from './types'

/**
 * The public status contract: the JSON that `/api/status.json`,
 * `/api/status/<slug>.json` and the badge routes serve, whether they come from
 * standalone StatusBeam or the EmDash plugin.
 *
 * This module is the `@statusbeam/core/contract` subpath entry. Keep its imports
 * to `zod` plus the pure `./types`, `./badge` and `./i18n` modules — importing
 * `./config` or `./check` would pull `yaml` into the render library.
 */

// Display helpers the render library (`@statusbeam/emdash-ui`) shares with
// `apps/web`, so both render the same contract data with the same labels and
// uptime math. All are pure and yaml-free.
export { DEFAULT_LOCALE, formatDay, getDict, LOCALES } from './i18n'
export type { DayKey, Dict, Locale } from './i18n'
export { formatUptime, overallSiteSeverity, toSeverity, windowUptime } from './types'
export type { CheckStatus, DayStat, Severity } from './types'

/**
 * Current contract version, carried in the body of the aggregate and per-site
 * responses (raw plugin routes cannot set custom headers).
 *
 * Additions that old consumers can ignore stay on this version. A site not
 * checked yet is one: it is marked by an optional `pending: true` beside a
 * placeholder `status: 'down'`, rather than by a new `status` value, because a
 * consumer that parses `status` as the closed `up | degraded | down` enum would
 * reject the whole body on an unknown value, while it strips an unknown key.
 * The key is omitted for a checked site, so those bodies are unchanged.
 */
export const CONTRACT_VERSION = 1

const checkStatusSchema = z.enum(['up', 'degraded', 'down'])

const severitySchema = z.enum(['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'])

const dayStatSchema = z.object({
  date: z.string(),
  status: checkStatusSchema.nullable(),
  uptime: z.number(),
})

/**
 * `true` when the site has no real result yet ("not checked yet"); omitted
 * otherwise. Its `status` is then a placeholder `down`, not an observed outage.
 */
const pendingSchema = z.boolean().optional()

const responsePointSchema = z.object({
  at: z.string(),
  ms: z.number(),
})

/** Aggregate `/api/status.json` body. */
export const statusResponseSchema = z.object({
  version: z.literal(CONTRACT_VERSION),
  status: severitySchema,
  generatedAt: z.string(),
  sites: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    status: checkStatusSchema,
    pending: pendingSchema,
    responseTime: z.number(),
    uptime: z.object({ day: z.string(), week: z.string(), month: z.string() }),
  })),
})
export type StatusResponse = z.infer<typeof statusResponseSchema>

/** Per-site `/api/status/<slug>.json` body: the full `SiteSummary` plus `version`. */
export const siteResponseSchema = z.object({
  version: z.literal(CONTRACT_VERSION),
  slug: z.string(),
  name: z.string(),
  status: checkStatusSchema,
  pending: pendingSchema,
  responseTime: z.number(),
  uptimeDay: z.string(),
  uptimeWeek: z.string(),
  uptimeMonth: z.string(),
  history: z.array(dayStatSchema),
  responseHistory: z.array(responsePointSchema).optional(),
})
export type SiteResponse = z.infer<typeof siteResponseSchema>

/** shields.io endpoint badge body (`schemaVersion` is shields.io's, not ours). */
export const shieldsEndpointSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.string(),
  message: z.string(),
  color: z.string(),
})

/**
 * Build the aggregate response. `now` is injected so callers (and tests) control
 * `generatedAt`. The overall `status` ignores sites not checked yet.
 */
export function buildStatusResponse(summary: SiteSummary[], now: Date = new Date()): StatusResponse {
  return {
    version: CONTRACT_VERSION,
    status: overallSiteSeverity(summary),
    generatedAt: now.toISOString(),
    sites: summary.map(s => ({
      slug: s.slug,
      name: s.name,
      status: s.status,
      ...(s.pending ? { pending: true } : {}),
      responseTime: s.responseTime,
      uptime: { day: s.uptimeDay, week: s.uptimeWeek, month: s.uptimeMonth },
    })),
  }
}

/** Build the per-site response: the whole `SiteSummary` behind a `version` field. */
export function buildSiteResponse(site: SiteSummary): SiteResponse {
  return { version: CONTRACT_VERSION, ...site }
}

const PERIODS: readonly UptimePeriod[] = ['day', 'week', 'month']

/** Coerce a `period` query value to a valid uptime window, defaulting to `month`. */
export function parsePeriod(value: string | null | undefined): UptimePeriod {
  return PERIODS.includes(value as UptimePeriod) ? (value as UptimePeriod) : 'month'
}

/** Which producer a path is for. */
export type RouteFlavor = 'standalone' | 'emdash'

/** URL builders for one flavor; each returns a path (with query string where needed). */
export interface RoutePaths {
  status: () => string
  site: (slug: string) => string
  badge: () => string
  siteBadge: (slug: string) => string
  uptimeBadge: (slug: string, period?: UptimePeriod) => string
  responseTimeBadge: (slug: string) => string
}

/** Base path the EmDash host mounts plugin routes under. */
export const EMDASH_ROUTE_BASE = '/_emdash/api/plugins/statusbeam'

function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return pairs.length > 0 ? `?${pairs.join('&')}` : ''
}

/**
 * Route-path map for both producers. Standalone puts the slug in the path and
 * the period in the query; the EmDash plugin has flat route names, so slug and
 * period are query params.
 */
export const routePaths: Record<RouteFlavor, RoutePaths> = {
  standalone: {
    status: () => '/api/status.json',
    site: slug => `/api/status/${encodeURIComponent(slug)}.json`,
    badge: () => '/api/badge.json',
    siteBadge: slug => `/api/badge/${encodeURIComponent(slug)}.json`,
    uptimeBadge: (slug, period) =>
      `/api/badge/${encodeURIComponent(slug)}/uptime.json${query({ period })}`,
    responseTimeBadge: slug => `/api/badge/${encodeURIComponent(slug)}/response-time.json`,
  },
  emdash: {
    status: () => `${EMDASH_ROUTE_BASE}/status`,
    site: slug => `${EMDASH_ROUTE_BASE}/status${query({ slug })}`,
    badge: () => `${EMDASH_ROUTE_BASE}/badge`,
    siteBadge: slug => `${EMDASH_ROUTE_BASE}/badge${query({ slug })}`,
    uptimeBadge: (slug, period) => `${EMDASH_ROUTE_BASE}/badge-uptime${query({ slug, period })}`,
    responseTimeBadge: slug => `${EMDASH_ROUTE_BASE}/badge-response-time${query({ slug })}`,
  },
}
