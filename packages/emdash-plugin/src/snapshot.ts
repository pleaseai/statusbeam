import type { CheckResult, CheckStatus, DayStat, Site, SiteSummary } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import type { DayBucket } from './buckets'
import type { DeliveryOutcome } from './notify'
import { buildSiteSummaries, dayStatFromCounts, denseHistory } from '@statusbeam/core'
import { toDayCounts } from './buckets'

const SNAPSHOT_PREFIX = 'snapshot:'

/**
 * A persistent mark on a monitor the host cannot probe. `body`: the response
 * body exceeds the host's size cap, so every probe is rejected before the
 * engine can read a status. It stays until a later probe completes normally.
 */
export interface MonitorWarning {
  limit: 'body'
  /** ISO time of the first probe that hit the limit in this unbroken run of them. */
  since: string
  /** ISO time of the latest probe that hit it. */
  lastSeen: string
}

/**
 * Everything the status page needs to know about one monitor. A result that
 * hit a host limit is not a real outcome, so it never replaces `result`, never
 * reaches `days`, and never counts as a status change; it only sets `warning`.
 */
export interface MonitorState {
  slug: string
  /** The latest real result, and the status the next run's change detection compares against. `null` before the first one. */
  result: CheckResult | null
  /** Dense 90-day window ending on the day of the run, oldest first. */
  days: DayStat[]
  /**
   * Checks counted behind each day in `days`, by date. A shard's state counts
   * polls and a webhook state counts webhook events, so the merge can add the
   * two sources exactly. Absent in state written before this field existed.
   */
  totals?: Record<string, number>
  warning?: MonitorWarning
}

/**
 * What one shard task leaves in `ctx.kv`. Each shard owns its own key, so
 * concurrent shard tasks never read-modify-write the same value.
 */
export interface ShardSnapshot {
  version: 2
  shard: number
  /** ISO time the shard finished its run. */
  updatedAt: string
  monitors: MonitorState[]
  /** The notification deliveries of this run, with redacted targets. */
  deliveries: DeliveryOutcome[]
  /** Set when the destinations leave this shard no call for a single probe; it probed nothing. */
  capacityError?: string
}

/**
 * What one webhook leaves in `ctx.kv` for its monitor: the latest webhook
 * result and the 90-day day stats of webhook events. The webhook route owns
 * these keys and never writes a shard key; shards never write these. Both live
 * under {@link SNAPSHOT_PREFIX}, so readers still list everything in one call.
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
  /** Set when a status change was recorded but not delivered because the destinations exceed the invocation's call budget. */
  deliverySkipped?: 'capacity'
}

export function snapshotKey(shard: number): string {
  return `${SNAPSHOT_PREFIX}${shard}`
}

export function webhookSnapshotKey(slug: string): string {
  return `${SNAPSHOT_PREFIX}webhook:${slug}`
}

interface KvEntry { key: string, value: unknown }

/** Write a monitor's webhook snapshot (one bridge call). */
export async function writeWebhookSnapshot(ctx: Pick<PluginContext, 'kv'>, snapshot: WebhookSnapshot): Promise<void> {
  await ctx.kv.set(webhookSnapshotKey(snapshot.slug), snapshot)
}

/** Read every shard snapshot (one bridge call: a prefix list). */
export async function listSnapshots(ctx: Pick<PluginContext, 'kv'>): Promise<KvEntry[]> {
  return ctx.kv.list(SNAPSHOT_PREFIX)
}

/** Write a shard's snapshot (one bridge call). */
export async function writeShardSnapshot(ctx: Pick<PluginContext, 'kv'>, snapshot: ShardSnapshot): Promise<void> {
  await ctx.kv.set(snapshotKey(snapshot.shard), snapshot)
}

export interface MergedSnapshot {
  /** Latest known state per monitor slug, across every shard and webhook. */
  monitors: Map<string, MonitorState>
  /** Latest real result per monitor slug, across every shard and webhook. */
  results: Map<string, CheckResult>
  /** The newest `updatedAt` of any shard or webhook snapshot, or `null` before the first. */
  updatedAt: string | null
  /** Capacity errors the shards recorded. */
  capacityErrors: string[]
  /** Poll-only state per slug (newest shard wins): what a shard run carries over, so it never absorbs webhook counts. */
  polled: Map<string, MonitorState>
  /** Webhook-only state per slug: what the next webhook for that slug carries over. */
  pushed: Map<string, MonitorState>
}

function isSnapshot(value: unknown): value is ShardSnapshot {
  return typeof value === 'object' && value !== null && (value as ShardSnapshot).version === 2 && Array.isArray((value as ShardSnapshot).monitors)
}

function isWebhookSnapshot(value: unknown): value is WebhookSnapshot {
  const candidate = value as WebhookSnapshot
  return typeof value === 'object' && value !== null && candidate.version === 2 && candidate.webhook === true && typeof candidate.monitor === 'object' && candidate.monitor !== null
}

const SEVERITY: Record<CheckStatus, number> = { up: 0, degraded: 1, down: 2 }

/**
 * One monitor seen by a shard and by a webhook. The newest real result wins.
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
  for (const stat of pushed.days.filter(stat => stat.status !== null)) {
    const other = polledDays.get(stat.date)
    const [a, b] = [polled.totals?.[stat.date], pushed.totals?.[stat.date]]
    if (!other || a === undefined || b === undefined) {
      days.set(stat.date, other ?? stat)
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
  }
  const merged: MonitorState = { slug: polled.slug, result, days: denseHistory(days, now), totals }
  if (polled.warning) {
    merged.warning = polled.warning
  }
  return merged
}

/**
 * Merge shard and webhook snapshots into one view. When a monitor appears in
 * more than one shard snapshot, which happens briefly after a configuration
 * change moves it between shards, the newest snapshot wins. A monitor that also
 * has a webhook snapshot is then combined with it (see {@link combineMonitors}),
 * and a webhook-only monitor is taken from its webhook snapshot. Pure; shared by
 * the scheduled run and the webhook (to find each monitor's previous state
 * wherever it ran last) and the readers.
 */
export function mergeSnapshots(entries: KvEntry[]): MergedSnapshot {
  const byAge = (a: { updatedAt: string }, b: { updatedAt: string }): number => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)
  const values = entries.map(entry => entry.value)
  const snapshots = values.filter(isSnapshot).sort(byAge)
  const webhooks = values.filter(isWebhookSnapshot).sort(byAge)
  const polled = new Map<string, MonitorState>()
  const pushed = new Map<string, MonitorState>()
  const capacityErrors: string[] = []
  for (const snapshot of snapshots) {
    if (snapshot.capacityError) {
      capacityErrors.push(snapshot.capacityError)
    }
    for (const monitor of snapshot.monitors) {
      polled.set(monitor.slug, monitor)
    }
  }
  for (const webhook of webhooks) {
    pushed.set(webhook.monitor.slug, webhook.monitor)
  }
  const updatedAt = [...snapshots, ...webhooks].sort(byAge).at(-1)?.updatedAt ?? null
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
  return { monitors, results, updatedAt, capacityErrors, polled, pushed }
}

/**
 * Merge every shard snapshot into one view (one bridge call: a prefix list).
 * Readers (the public routes, T006) use this instead of knowing the shard layout.
 */
export async function readSnapshot(ctx: Pick<PluginContext, 'kv'>): Promise<MergedSnapshot> {
  return mergeSnapshots(await listSnapshots(ctx))
}

/**
 * The state of one monitor after a probe. `buckets` are the monitor's day
 * buckets as they stand after this probe's counts were added. Today's day stat
 * (and any other day a bucket covers) is recomputed from them, so the buckets
 * stay the durable source; older days carry over from `previous`, and the
 * window shifts when the day rolls over.
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
  const state: MonitorState = {
    slug: result.slug,
    result: result.limit ? previous?.result ?? null : result,
    days: dense,
    totals: Object.fromEntries(dense.flatMap(stat => (stat.date in totals ? [[stat.date, totals[stat.date] as number]] : []))),
  }
  if (result.limit) {
    state.warning = { limit: result.limit, since: previous?.warning?.since ?? result.checkedAt, lastSeen: result.checkedAt }
  }
  return state
}

/**
 * Turn the merged snapshot into the `SiteSummary`s the status endpoints serve:
 * status and latency from each monitor's latest real result, per-day, week and
 * month uptime from its day stats. A monitor with no real result yet reads as
 * core's default (`down`); its warning is on `merged.monitors`.
 */
export function summariesFromSnapshot(merged: MergedSnapshot, sites: Site[], now: Date): SiteSummary[] {
  const historyBySlug = new Map<string, Map<string, DayStat>>()
  for (const [slug, monitor] of merged.monitors) {
    historyBySlug.set(slug, new Map(monitor.days.filter(stat => stat.status !== null).map(stat => [stat.date, stat])))
  }
  return buildSiteSummaries({ sites, results: [...merged.results.values()], previous: new Map(), historyBySlug, now })
}
