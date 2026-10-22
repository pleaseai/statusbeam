import type { SiteSummary } from './types'
import { overallSiteSeverity, toSeverity } from './types'

/**
 * A shields.io [endpoint badge](https://shields.io/badges/endpoint-badge)
 * response. Users point `https://img.shields.io/endpoint?url=<our JSON URL>` at
 * one of the `/api/badge/*` routes and shields.io renders the SVG — so we never
 * generate images ourselves, only this small JSON contract.
 */
export interface ShieldsEndpoint {
  /** Always `1`; the only schema shields.io currently understands. */
  schemaVersion: 1
  /** Left side of the badge. */
  label: string
  /** Right side of the badge. */
  message: string
  /** Right-side background: a shields named color or `rrggbb` hex. */
  color: string
}

/** Uptime window a badge can report; mirrors the SiteSummary trailing fields. */
export type UptimePeriod = 'day' | 'week' | 'month'

/**
 * The shields.io named colors this module emits. The color functions return
 * this union (not bare `string`) so a typo — `'brigthgreen'` — fails to compile
 * instead of slipping through to a broken badge. `ShieldsEndpoint.color` stays
 * `string` because the wire contract also accepts raw `rrggbb` hex.
 */
export type BadgeColor = 'brightgreen' | 'green' | 'yellowgreen' | 'yellow' | 'orange' | 'red' | 'blue' | 'lightgrey'

/**
 * Badge message for a site not checked yet (`pending`). Its `status` is a
 * placeholder `down`, so badges report this neutral message in grey instead of
 * an outage nobody observed.
 */
export const NOT_CHECKED_MESSAGE = 'not checked'

/** The neutral badge body for a site not checked yet. */
function notCheckedBadge(label: string): ShieldsEndpoint {
  return { schemaVersion: 1, label, message: NOT_CHECKED_MESSAGE, color: 'lightgrey' }
}

/** Map a display severity to a shields.io badge color. */
export function severityColor(status: SiteSummary['status']): BadgeColor {
  switch (toSeverity(status)) {
    case 'operational':
      return 'brightgreen'
    case 'degraded':
      return 'yellow'
    case 'partial_outage':
      return 'orange'
    case 'major_outage':
      return 'red'
    case 'maintenance':
      return 'blue'
  }
}

/** Human-readable badge message for a site's current status. */
export function statusMessage(status: SiteSummary['status']): string {
  switch (status) {
    case 'up':
      return 'up'
    case 'degraded':
      return 'degraded'
    case 'down':
      return 'down'
  }
}

/**
 * Badge color for an uptime ratio (0..1), from healthy (green) to poor (red).
 * Thresholds match common status-page conventions (three nines is excellent).
 */
export function uptimeColor(ratio: number): BadgeColor {
  if (ratio >= 0.999) {
    return 'brightgreen'
  }
  if (ratio >= 0.99) {
    return 'green'
  }
  if (ratio >= 0.95) {
    return 'yellow'
  }
  if (ratio >= 0.9) {
    return 'orange'
  }
  return 'red'
}

/**
 * Badge color for a response time in ms, from fast (green) to slow (red).
 * Lower is better, so the scale is inverted relative to {@link uptimeColor}.
 */
export function responseColor(ms: number): BadgeColor {
  if (ms <= 200) {
    return 'brightgreen'
  }
  if (ms <= 500) {
    return 'green'
  }
  if (ms <= 1000) {
    return 'yellowgreen'
  }
  if (ms <= 2000) {
    return 'yellow'
  }
  if (ms <= 4000) {
    return 'orange'
  }
  return 'red'
}

/**
 * Parse a formatted uptime string (e.g. `"99.98%"`, `"100%"`) back to a ratio
 * (0..1). Returns `1` for anything unparseable so a malformed snapshot degrades
 * to a green badge rather than throwing on the request path.
 */
export function parseUptimePercent(display: string): number {
  const pct = Number.parseFloat(display)
  return Number.isFinite(pct) ? pct / 100 : 1
}

/**
 * The trailing uptime display string a `SiteSummary` holds for `period`.
 * `getSummary()` trusts KV's JSON via a type assertion rather than runtime
 * validation, so a stale or malformed snapshot can carry a missing field
 * despite the type saying `string` — falls back to `'n/a'` so the badge JSON
 * still has a `message`, instead of shields.io getting an omitted field.
 */
function uptimeDisplay(site: SiteSummary, period: UptimePeriod): string {
  switch (period) {
    case 'day':
      return site.uptimeDay ?? 'n/a'
    case 'week':
      return site.uptimeWeek ?? 'n/a'
    case 'month':
      return site.uptimeMonth ?? 'n/a'
  }
}

/** Status badge for one site: `<name> | up|degraded|down`, or `not checked` in grey while pending. */
export function statusBadge(site: SiteSummary): ShieldsEndpoint {
  if (site.pending) {
    return notCheckedBadge(site.name)
  }
  return {
    schemaVersion: 1,
    label: site.name,
    message: statusMessage(site.status),
    color: severityColor(site.status),
  }
}

/**
 * Overall status badge across every site (worst status wins). Label is
 * `status`; message is `operational` when all up, else the worst severity.
 * Sites not checked yet are ignored, as in the aggregate status.
 */
export function overallBadge(summary: SiteSummary[]): ShieldsEndpoint {
  const checked = summary.filter(s => !s.pending)
  const severity = overallSiteSeverity(checked)
  const message = severity === 'operational'
    ? 'operational'
    : severity.replace(/_/g, ' ')
  // Color keys off the worst site's raw status so severityColor's mapping is reused.
  const worst = checked.find(s => s.status === 'down')
    ?? checked.find(s => s.status === 'degraded')
    ?? checked[0]
  return {
    schemaVersion: 1,
    label: 'status',
    message,
    color: worst ? severityColor(worst.status) : 'brightgreen',
  }
}

/**
 * Uptime badge for one site over `period` (default `month`). A site not checked
 * yet has no uptime to report, so it gets the neutral `not checked` badge.
 */
export function uptimeBadge(site: SiteSummary, period: UptimePeriod = 'month'): ShieldsEndpoint {
  if (site.pending) {
    return notCheckedBadge('uptime')
  }
  const display = uptimeDisplay(site, period)
  return {
    schemaVersion: 1,
    label: 'uptime',
    message: display,
    color: uptimeColor(parseUptimePercent(display)),
  }
}

/**
 * Response-time badge for one site: `response time | <n>ms`. A down site's
 * check never received a response, so `responseTime` is `0` — reported as-is
 * it would read as the fastest possible response instead of an outage, so a
 * down site gets a `down`/red badge instead of `0ms`/brightgreen. A site not
 * checked yet has no response either, and no outage: `not checked` in grey.
 */
export function responseBadge(site: SiteSummary): ShieldsEndpoint {
  if (site.pending) {
    return notCheckedBadge('response time')
  }
  if (site.status === 'down') {
    return {
      schemaVersion: 1,
      label: 'response time',
      message: 'down',
      color: 'red',
    }
  }
  return {
    schemaVersion: 1,
    label: 'response time',
    message: `${site.responseTime}ms`,
    color: responseColor(site.responseTime),
  }
}
