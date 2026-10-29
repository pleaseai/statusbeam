import type { CheckResult, CheckStatus, DayStat, Site, SiteSummary } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import type { DayBucket } from './buckets'
import type { DeliveryOutcome } from './notify'
import { buildSiteSummaries, dayStatFromCounts, denseHistory } from '@statusbeam/core'
import { toDayCounts } from './buckets'

const SNAPSHOT_PREFIX = 'snapshot:'

/**
 * Longest `error` kept in a stored result, in UTF-16 units. A provider can put its
 * whole validation message there (tens of KB), and the poll snapshot is one D1 row.
 */
export const MAX_STORED_ERROR_LENGTH = 300

/** The error cut to {@link MAX_STORED_ERROR_LENGTH} with a trailing `…`, never splitting a surrogate pair. */
function boundedError(error: string): string {
  if (error.length <= MAX_STORED_ERROR_LENGTH) {
    return error
  }
  let end = MAX_STORED_ERROR_LENGTH - 1
  const point = error.codePointAt(end - 1) ?? 0
  if (point > 0xFFFF || (point >= 0xD800 && point <= 0xDBFF)) {
    end--
  }
  return `${error.slice(0, end)}…`
}

/** Everything the status page needs to know about one monitor. */
export interface MonitorState {
  slug: string
  /** The latest result, and the status the next run's change detection compares against. `null` before the first one. */
  result: CheckResult | null
  /** Dense 90-day window ending on the day of the run, oldest first. */
  days: DayStat[]
  /**
   * Checks counted behind each day in `days`, by date. The poll state counts
   * polls and a webhook state counts webhook events, so the merge can add the
   * two sources exactly.
   */
  totals: Record<string, number>
}

/**
 * What the scheduled check leaves in `ctx.kv`: one snapshot for every monitor.
 * It owns its key alone, so a webhook (which writes its own keys) never
 * read-modify-writes the same value.
 */
export interface PollSnapshot {
  version: 2
  /** ISO time the check finished its run. */
  updatedAt: string
  /** One entry per monitor in the configuration at the time of the run; a monitor removed since is gone. */
  monitors: MonitorState[]
  /** The notification deliveries of this run, with redacted targets. */
  deliveries: DeliveryOutcome[]
}

/**
 * What one webhook leaves in `ctx.kv` for its monitor: the latest webhook
 * result and the 90-day day stats of webhook events. The webhook route owns
 * these keys and never writes the poll key; the check never writes these. Both
 * live under {@link SNAPSHOT_PREFIX}, so readers still list everything in one call.
 */
export interface WebhookSnapshot {
  version: 2
  webhook: true
  slug: string
  /** ISO time the webhook was processed. */
  updatedAt: string
  /** This monitor's webhook-sourced state (result, day stats and totals count webhook events only). */
  monitor: MonitorState
  /** The notification deliveries of this event, with redacted targets. */
  deliveries: DeliveryOutcome[]
}

/** Key of the poll snapshot. */
export const POLL_SNAPSHOT_KEY = `${SNAPSHOT_PREFIX}poll`

export function webhookSnapshotKey(slug: string): string {
  return `${SNAPSHOT_PREFIX}webhook:${slug}`
}

interface KvEntry { key: string, value: unknown }

/** Write a monitor's webhook snapshot. */
export async function writeWebhookSnapshot(ctx: Pick<PluginContext, 'kv'>, snapshot: WebhookSnapshot): Promise<void> {
  await ctx.kv.set(webhookSnapshotKey(snapshot.slug), snapshot)
}

/** Read every snapshot entry (one prefix list). */
export async function listSnapshots(ctx: Pick<PluginContext, 'kv'>): Promise<KvEntry[]> {
  return ctx.kv.list(SNAPSHOT_PREFIX)
}

/** Write the poll snapshot. */
export async function writePollSnapshot(ctx: Pick<PluginContext, 'kv'>, snapshot: PollSnapshot): Promise<void> {
  await ctx.kv.set(POLL_SNAPSHOT_KEY, snapshot)
}

export interface MergedSnapshot {
  /** Latest known state per monitor slug, from the poll and the webhooks. */
  monitors: Map<string, MonitorState>
  /** Latest result per monitor slug, from the poll and the webhooks. */
  results: Map<string, CheckResult>
  /** The newest `updatedAt` of the poll or any webhook snapshot, or `null` before the first. */
  updatedAt: string | null
  /** Poll-only state per slug: what the next run carries over, so it never absorbs webhook counts. */
  polled: Map<string, MonitorState>
  /** Webhook-only state per slug: what the next webhook for that slug carries over. */
  pushed: Map<string, MonitorState>
}

function isSnapshot(value: unknown): value is PollSnapshot {
  return typeof value === 'object' && value !== null && (value as PollSnapshot).version === 2 && Array.isArray((value as PollSnapshot).monitors)
}

function isWebhookSnapshot(value: unknown): value is WebhookSnapshot {
  const candidate = value as WebhookSnapshot
  return typeof value === 'object' && value !== null && candidate.version === 2 && candidate.webhook === true && typeof candidate.monitor === 'object' && candidate.monitor !== null
}

/** State written before `totals` existed reads as having no counts, so every later step can rely on the field. */
function monitorWithTotals(monitor: MonitorState): MonitorState {
  return monitor.totals ? monitor : { ...monitor, totals: {} }
}

function withTotals(snapshot: PollSnapshot): PollSnapshot {
  return { ...snapshot, monitors: snapshot.monitors.map(monitorWithTotals) }
}

const SEVERITY: Record<CheckStatus, number> = { up: 0, degraded: 1, down: 2 }

/**
 * One monitor seen by the poll and by a webhook. The newest real result wins.
 * Each day adds the two sources' counts: the status is the worse of the two and
 * the uptime is the combined `up / total`, which is what the day's two bucket
 * rows summed would give. A day only one source saw is taken as it is. Neither
 * source's state is ever rewritten by the other, so no count is counted twice.
 */
function combineMonitors(polled: MonitorState, pushed: MonitorState, now: Date): MonitorState {
  const result = polled.result && pushed.result
    ? (pushed.result.checkedAt >= polled.result.checkedAt ? pushed.result : polled.result)
    : polled.result ?? pushed.result
  const days = new Map<string, DayStat>()
  const totals: Record<string, number> = {}
  const polledDays = new Map(polled.days.filter(stat => stat.status !== null).map(stat => [stat.date, stat]))
  // A day only one source counted keeps that source's count, so the merged state still adds up exactly.
  const keepTotal = (date: string, source: MonitorState) => {
    const total = source.totals[date]
    if (total !== undefined) {
      totals[date] = total
    }
  }
  for (const stat of pushed.days.filter(stat => stat.status !== null)) {
    const other = polledDays.get(stat.date)
    const [a, b] = [polled.totals[stat.date], pushed.totals[stat.date]]
    if (!other || a === undefined || b === undefined) {
      days.set(stat.date, other ?? stat)
      keepTotal(stat.date, other ? polled : pushed)
      polledDays.delete(stat.date)
      continue
    }
    const total = a + b
    const up = Math.round(other.uptime * a) + Math.round(stat.uptime * b)
    const worse = SEVERITY[stat.status as CheckStatus] > SEVERITY[other.status as CheckStatus] ? stat : other
    days.set(stat.date, { date: stat.date, status: worse.status, uptime: total ? up / total : 1 })
    totals[stat.date] = total
    polledDays.delete(stat.date)
  }
  for (const [date, stat] of polledDays) {
    days.set(date, stat)
    keepTotal(date, polled)
  }
  return { slug: polled.slug, result, days: denseHistory(days, now), totals }
}

/**
 * Merge the poll snapshot and the webhook snapshots into one view. A monitor
 * that also has a webhook snapshot is combined with it (see
 * {@link combineMonitors}), and a webhook-only monitor is taken from its webhook
 * snapshot. Pure; shared by the scheduled check and the webhook (to find each
 * monitor's previous state) and the readers.
 */
export function mergeSnapshots(entries: KvEntry[]): MergedSnapshot {
  const byAge = (a: { updatedAt: string }, b: { updatedAt: string }): number => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)
  const poll = entries.find(entry => entry.key === POLL_SNAPSHOT_KEY && isSnapshot(entry.value))?.value as PollSnapshot | undefined
  const snapshot = poll ? withTotals(poll) : undefined
  const webhooks = entries.map(entry => entry.value).filter(isWebhookSnapshot).map(webhook => ({ ...webhook, monitor: monitorWithTotals(webhook.monitor) })).sort(byAge)
  const polled = new Map<string, MonitorState>((snapshot?.monitors ?? []).map(monitor => [monitor.slug, monitor]))
  const pushed = new Map<string, MonitorState>(webhooks.map(webhook => [webhook.monitor.slug, webhook.monitor]))
  const updatedAt = [...(snapshot ? [snapshot] : []), ...webhooks].sort(byAge).at(-1)?.updatedAt ?? null
  const now = updatedAt ? new Date(updatedAt) : new Date(0)
  const monitors = new Map<string, MonitorState>()
  const results = new Map<string, CheckResult>()
  for (const slug of new Set([...polled.keys(), ...pushed.keys()])) {
    const fromPoll = polled.get(slug)
    const fromWebhook = pushed.get(slug)
    const monitor = (fromPoll && fromWebhook ? combineMonitors(fromPoll, fromWebhook, now) : fromPoll ?? fromWebhook) as MonitorState
    monitors.set(slug, monitor)
    if (monitor.result) {
      results.set(slug, monitor.result)
    }
  }
  return { monitors, results, updatedAt, polled, pushed }
}

/** Merge every snapshot into one view (one prefix list). Readers use this instead of knowing the key layout. */
export async function readSnapshot(ctx: Pick<PluginContext, 'kv'>): Promise<MergedSnapshot> {
  return mergeSnapshots(await listSnapshots(ctx))
}

/**
 * The state of one monitor after a probe. `buckets` are the monitor's day
 * buckets as they stand after this probe's counts were added. Today's day stat
 * (and any other day a bucket covers) is recomputed from them, so the buckets
 * stay the durable source; older days carry over from `previous`, and the
 * window shifts when the day rolls over. The stored result's `error` is capped at
 * {@link MAX_STORED_ERROR_LENGTH}.
 */
export function advanceMonitor(
  previous: MonitorState | undefined,
  result: CheckResult,
  buckets: DayBucket[],
  now: Date,
): MonitorState {
  const days = new Map<string, DayStat>()
  for (const stat of previous?.days ?? []) {
    if (stat.status !== null) {
      days.set(stat.date, stat)
    }
  }
  const totals: Record<string, number> = {}
  for (const [date, total] of Object.entries(previous?.totals ?? {})) {
    if (days.has(date)) {
      totals[date] = total
    }
  }
  for (const bucket of buckets) {
    days.set(bucket.date, dayStatFromCounts(toDayCounts(bucket)))
    totals[bucket.date] = bucket.total
  }
  const dense = denseHistory(days, now)
  return {
    slug: result.slug,
    result: result.error === undefined ? result : { ...result, error: boundedError(result.error) },
    days: dense,
    totals: Object.fromEntries(dense.flatMap(stat => (stat.date in totals ? [[stat.date, totals[stat.date] as number]] : []))),
  }
}

/**
 * Turn the merged snapshot into the `SiteSummary`s the status endpoints serve:
 * status and latency from each monitor's latest result, per-day, week and month
 * uptime from its day stats. A monitor with no result yet (not probed, or a
 * webhook-only monitor before its first event) is `pending` ("not checked yet"),
 * as standalone serves it.
 */
export function summariesFromSnapshot(merged: MergedSnapshot, sites: Site[], now: Date): SiteSummary[] {
  const historyBySlug = new Map<string, Map<string, DayStat>>()
  for (const [slug, monitor] of merged.monitors) {
    historyBySlug.set(slug, new Map(monitor.days.filter(stat => stat.status !== null).map(stat => [stat.date, stat])))
  }
  return buildSiteSummaries({ sites, results: [...merged.results.values()], previous: new Map(), historyBySlug, now })
}
