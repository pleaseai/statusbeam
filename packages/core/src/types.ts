/** Raw verdict of a single check run. */
export type CheckStatus = 'up' | 'degraded' | 'down'

/** Display severity rolled up for the status page (superset of CheckStatus). */
export type Severity
  = | 'operational'
    | 'degraded'
    | 'partial_outage'
    | 'major_outage'
    | 'maintenance'

/** One check data point for one site. */
export interface CheckResult {
  slug: string
  status: CheckStatus
  /** HTTP status code (0 when the request never completed). */
  code: number
  /** Round-trip time in milliseconds. */
  responseTime: number
  /** ISO-8601 timestamp of when the check ran. */
  checkedAt: string
  /** Present when the check failed to complete. */
  error?: string
  /**
   * Set when the host's own limit ended the request, not the monitored target
   * (`body`: the response body exceeded the host's size cap). Only a caller that
   * injects a `classifyError` to {@link checkSite} sees it. The result is then
   * not a real outcome of the target: `status` is `down` with `code: 0` to stay
   * in the closed status set, but callers must not count it, grade it, or alert on it.
   */
  limit?: 'body'
}

/** One response-time sample, for the recent-latency sparkline. */
export interface ResponsePoint {
  /** ISO-8601 timestamp of the sample. */
  at: string
  /** Round-trip time in milliseconds. */
  ms: number
}

/** One calendar day's rolled-up outcome, for the 90-day timeline. */
export interface DayStat {
  /** ISO date, `YYYY-MM-DD` (UTC). */
  date: string
  /** Worst status seen that day; `null` when no checks ran (no data). */
  status: CheckStatus | null
  /** Fraction of checks that were `up` (0..1). `1` for a no-data day. */
  uptime: number
}

/** Aggregated current state for one site, served to the status page. */
export interface SiteSummary {
  slug: string
  name: string
  /**
   * Latest real status. A site not checked yet (see {@link SiteSummary.pending})
   * carries `down` here so consumers that predate `pending` read it as before.
   */
  status: CheckStatus
  /**
   * `true` when the site has no real result yet (never probed, or a
   * webhook-only monitor before its first event): its `status` is not a real
   * outcome, so it is shown as "not checked yet" and left out of the overall
   * severity and of change detection. Omitted (never `false`) otherwise, so the
   * serialized summary of a checked site is unchanged.
   */
  pending?: true
  responseTime: number
  /** Trailing uptime percentages as display strings, e.g. "99.98%". */
  uptimeDay: string
  uptimeWeek: string
  uptimeMonth: string
  /** Per-day history, oldest → newest, up to 90 entries. */
  history: DayStat[]
  /**
   * Recent response-time samples, oldest → newest. Optional so older KV
   * snapshots (written before this field existed) stay valid.
   */
  responseHistory?: ResponsePoint[]
}

/** Map CheckStatus → the display severity used by the banner and badges. */
export function toSeverity(status: CheckStatus): Severity {
  switch (status) {
    case 'up':
      return 'operational'
    case 'degraded':
      return 'degraded'
    case 'down':
      return 'major_outage'
  }
}

/** Roll up many site statuses into one overall severity (worst wins). */
export function overallSeverity(statuses: CheckStatus[]): Severity {
  if (statuses.includes('down')) {
    return 'major_outage'
  }
  if (statuses.includes('degraded')) {
    return 'degraded'
  }
  return 'operational'
}

/**
 * Overall severity across sites, ignoring sites not checked yet: their `down`
 * is a placeholder, not an observed outage. With every site pending (or none),
 * the result is `operational`.
 */
export function overallSiteSeverity(sites: Array<Pick<SiteSummary, 'status' | 'pending'>>): Severity {
  return overallSeverity(sites.filter(s => !s.pending).map(s => s.status))
}

/**
 * Average uptime over a day-stat window, ignoring no-data days. Returns `1`
 * when the window is empty or entirely no-data (nothing to report against).
 */
export function windowUptime(history: DayStat[]): number {
  const days = history.filter(d => d.status !== null)
  if (days.length === 0) {
    return 1
  }
  return days.reduce((sum, d) => sum + d.uptime, 0) / days.length
}

/** Format an uptime ratio (0..1) as a display percentage, e.g. "99.98%". */
export function formatUptime(ratio: number): string {
  const pct = ratio * 100
  // Avoid "100.00%" when a rounded value reaches 100.
  return pct >= 99.995 ? '100%' : `${pct.toFixed(2)}%`
}

/** Mean response time (ms) over a sample window; `0` for an empty window. */
export function averageResponse(points: ResponsePoint[]): number {
  if (points.length === 0) {
    return 0
  }
  const sum = points.reduce((total, p) => total + p.ms, 0)
  return Math.round(sum / points.length)
}

/**
 * The p-th percentile response time (ms) over a window, by nearest-rank. `p` is
 * a fraction in 0..1 (e.g. `0.95` for p95). Returns `0` for an empty window.
 */
export function percentileResponse(points: ResponsePoint[], p: number): number {
  if (points.length === 0) {
    return 0
  }
  const sorted = points.map(pt => pt.ms).sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length)
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1
  // `index` is clamped to a valid slot; `?? 0` only satisfies the type checker.
  return sorted[index] ?? 0
}
