import type { StatusConfig } from './config'
import type { StatusChange } from './notify'
import type { CheckResult, CheckStatus, DayStat, SiteSummary } from './types'
import { formatUptime, windowUptime } from './types'

/** Length of the status page timeline, in UTC calendar days (today included). */
export const HISTORY_DAYS = 90

/**
 * One (slug, day) row of per-status check counts — the shape a storage layer
 * (D1 `GROUP BY`, a plugin's per-day buckets) feeds into the rollup.
 */
export interface DayCounts {
  slug: string
  /** ISO date, `YYYY-MM-DD` (UTC). */
  day: string
  up: number
  degraded: number
  down: number
  total: number
}

/** UTC-midnight start of the {@link HISTORY_DAYS} window ending on `now`'s day. */
export function historyWindowStart(now: Date): Date {
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - (HISTORY_DAYS - 1))
  since.setUTCHours(0, 0, 0, 0)
  return since
}

/**
 * Roll one day's counts into a {@link DayStat}: the worst status seen
 * (`down` beats `degraded` beats `up`) and the fraction of `up` checks, `1` for
 * a day with no checks counted.
 */
export function dayStatFromCounts(counts: Pick<DayCounts, 'day' | 'up' | 'degraded' | 'down' | 'total'>): DayStat {
  const status: CheckStatus = counts.down > 0 ? 'down' : counts.degraded > 0 ? 'degraded' : 'up'
  return { date: counts.day, status, uptime: counts.total ? counts.up / counts.total : 1 }
}

/** Group count rows into slug → (date → {@link DayStat}). */
export function groupDayStats(rows: DayCounts[]): Map<string, Map<string, DayStat>> {
  const bySlug = new Map<string, Map<string, DayStat>>()
  for (const row of rows) {
    const days = bySlug.get(row.slug) ?? new Map<string, DayStat>()
    days.set(row.day, dayStatFromCounts(row))
    bySlug.set(row.slug, days)
  }
  return bySlug
}

/**
 * Expand sparse per-day stats into a dense {@link HISTORY_DAYS}-entry window
 * (oldest → newest, ending on `now`'s UTC day). Missing days are no-data
 * (`status: null`, `uptime: 1`).
 */
export function denseHistory(days: Map<string, DayStat> | undefined, now: Date): DayStat[] {
  const out: DayStat[] = []
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    const date = d.toISOString().slice(0, 10)
    out.push(days?.get(date) ?? { date, status: null, uptime: 1 })
  }
  return out
}

/**
 * Sites whose status flipped against the previous snapshot. A site with no
 * prior snapshot entry, or one not checked yet (`pending`, whose `down` is a
 * placeholder), has nothing real to compare to, so it never counts as changed.
 */
export function detectStatusChanges(
  results: CheckResult[],
  previous: Map<string, Pick<SiteSummary, 'status' | 'pending'>>,
): StatusChange[] {
  const changes: StatusChange[] = []
  for (const r of results) {
    const prior = previous.get(r.slug)
    if (prior !== undefined && !prior.pending && prior.status !== r.status) {
      changes.push({ slug: r.slug, from: prior.status, to: r.status })
    }
  }
  return changes
}

/**
 * Build the snapshot the status page reads. `results` may cover only some sites
 * (a webhook updates one); a site absent from it falls back to its `previous`
 * summary value, so a partial batch never blanks untouched sites. A site with
 * neither has not been checked yet: it is `pending` with a placeholder
 * `down`/`0`, and stays pending until its first real result. Trailing uptime
 * windows are tail slices of the same dense history.
 */
export function buildSiteSummaries(input: {
  sites: StatusConfig['sites']
  results: CheckResult[]
  previous: Map<string, SiteSummary>
  historyBySlug: Map<string, Map<string, DayStat>>
  now: Date
}): SiteSummary[] {
  const bySlug = new Map(input.results.map(r => [r.slug, r]))
  return input.sites.map((site) => {
    const r = bySlug.get(site.slug)
    const prior = input.previous.get(site.slug)
    const history = denseHistory(input.historyBySlug.get(site.slug), input.now)
    const pending = r === undefined && (prior === undefined || prior.pending === true)
    return {
      slug: site.slug,
      name: site.name,
      status: r?.status ?? prior?.status ?? 'down',
      ...(pending ? { pending: true } : {}),
      responseTime: r?.responseTime ?? prior?.responseTime ?? 0,
      uptimeDay: formatUptime(windowUptime(history.slice(-1))),
      uptimeWeek: formatUptime(windowUptime(history.slice(-7))),
      uptimeMonth: formatUptime(windowUptime(history.slice(-30))),
      history,
    }
  })
}
