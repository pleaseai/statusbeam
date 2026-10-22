import type { CheckResult, DayStat, Site, SiteSummary } from '@statusbeam/core'
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

export function snapshotKey(shard: number): string {
  return `${SNAPSHOT_PREFIX}${shard}`
}

interface KvEntry { key: string, value: unknown }

/** Read every shard snapshot (one bridge call: a prefix list). */
export async function listSnapshots(ctx: Pick<PluginContext, 'kv'>): Promise<KvEntry[]> {
  return ctx.kv.list(SNAPSHOT_PREFIX)
}

/** Write a shard's snapshot (one bridge call). */
export async function writeShardSnapshot(ctx: Pick<PluginContext, 'kv'>, snapshot: ShardSnapshot): Promise<void> {
  await ctx.kv.set(snapshotKey(snapshot.shard), snapshot)
}

export interface MergedSnapshot {
  /** Latest known state per monitor slug, across every shard. */
  monitors: Map<string, MonitorState>
  /** Latest real result per monitor slug, across every shard. */
  results: Map<string, CheckResult>
  /** The newest shard `updatedAt`, or `null` before any shard has run. */
  updatedAt: string | null
  /** Capacity errors the shards recorded. */
  capacityErrors: string[]
}

function isSnapshot(value: unknown): value is ShardSnapshot {
  return typeof value === 'object' && value !== null && (value as ShardSnapshot).version === 2 && Array.isArray((value as ShardSnapshot).monitors)
}

/**
 * Merge shard snapshots into one view. When a monitor appears in more than one
 * snapshot, which happens briefly after a configuration change moves it between
 * shards, the newest snapshot wins. Pure; shared by the scheduled run (to find
 * each monitor's previous state wherever it ran last) and the readers.
 */
export function mergeSnapshots(entries: KvEntry[]): MergedSnapshot {
  const snapshots = entries.map(entry => entry.value).filter(isSnapshot).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
  const monitors = new Map<string, MonitorState>()
  const results = new Map<string, CheckResult>()
  const capacityErrors: string[] = []
  for (const snapshot of snapshots) {
    if (snapshot.capacityError) {
      capacityErrors.push(snapshot.capacityError)
    }
    for (const monitor of snapshot.monitors) {
      monitors.set(monitor.slug, monitor)
      if (monitor.result) {
        results.set(monitor.slug, monitor.result)
      }
      else {
        results.delete(monitor.slug)
      }
    }
  }
  return { monitors, results, updatedAt: snapshots.at(-1)?.updatedAt ?? null, capacityErrors }
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
  for (const bucket of buckets) {
    days.set(bucket.date, dayStatFromCounts(toDayCounts(bucket)))
  }
  const state: MonitorState = {
    slug: result.slug,
    result: result.limit ? previous?.result ?? null : result,
    days: denseHistory(days, now),
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
