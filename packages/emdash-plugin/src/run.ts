import type { CheckResult } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import type { DeliveryOutcome } from './notify'
import type { ShardSnapshot } from './snapshot'
import { detectStatusChanges } from '@statusbeam/core'
import { applyResults, bucketId, bucketsOf, dayOf, pruneExpiredBuckets, touchedBucketIds } from './buckets'
import { CALL_BUDGET, monitorsPerTask, plannedCalls, PROBE_DEADLINE_MS, reservedCallsFor } from './budget'
import { clearConfigError, CONFIG_ERROR_KEY, loadStoredConfig, recordConfigError } from './config'
import { buildMessages, deliver } from './notify'
import { probeSite } from './probe'
import { pollableSites, reconcileShards, shardSites } from './shards'
import { advanceMonitor, listSnapshots, mergeSnapshots, writeShardSnapshot } from './snapshot'

type RunContext = Pick<PluginContext, 'settings' | 'kv' | 'storage' | 'http'>

export interface ShardRunOptions {
  now?: () => Date
  /** Per-probe and per-delivery deadline in ms. */
  deadlineMs?: number
}

export interface ShardRunResult {
  /** Monitors probed. */
  probed: number
  /** Bridge calls the run made. */
  calls: number
  /** Bridge calls the plan set aside before the first probe: the fixed calls, one per probe, one per destination, and one more when the run clears a stale configuration-error record. `calls` never exceeds it. */
  planned: number
  /** Probes the host's limit rejected; those monitors are marked unsupported, not graded. */
  unsupported: number
  /** Deliveries attempted (each reserves one call; zero when nothing changed). */
  deliveries: number
}

/** UTC day of a date as `YYYY-MM-DD`. */
function dayOfDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * One shard task: probe the shard's monitors through `ctx.http.fetch`, notify
 * the destinations of status changes, add the outcomes to the per-day buckets,
 * and write the shard snapshot.
 *
 * Its calls are planned before the first probe, from the settings it reads
 * first: five fixed calls, one fetch per monitor, and one
 * call reserved per destination, which the sharding sized the monitor count for.
 * It never calls `ctx.log`; the delivery outcomes live in the snapshot.
 * The order is settings, probes (concurrent, each under its own deadline),
 * reads, deliveries, then the two writes. A run the runtime ends before the
 * writes leaves the buckets and the snapshot as they were: the next run sees the
 * same previous status and tells the destinations again, which is a duplicate
 * message, never a lost one.
 *
 * A probe that hit the host's body limit says nothing about the target. It is
 * not counted in the buckets, not compared for change detection, and does not
 * replace the monitor's last result; the monitor keeps a warning until a later
 * probe completes normally. An absent or invalid configuration, or an empty
 * shard, checks nothing and writes nothing.
 */
export async function runShard(ctx: RunContext, shard: number, options: ShardRunOptions = {}): Promise<ShardRunResult> {
  const now = options.now ?? (() => new Date())
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS
  const idle = (calls: number, planned = calls): ShardRunResult => ({ probed: 0, calls, planned, unsupported: 0, deliveries: 0 })

  const stored = await loadStoredConfig(ctx)
  if (stored.status === 'absent') {
    return idle(1)
  }
  if (stored.status === 'invalid') {
    await recordConfigError(ctx, stored.issues, now())
    return idle(2)
  }
  const { config, destinations } = stored

  const pollable = pollableSites(config)
  const reserved = reservedCallsFor(destinations.length)
  if (monitorsPerTask(reserved) < 1) {
    if (pollable.length === 0) {
      return idle(1)
    }
    const capacityError = `${destinations.length} notification destinations leave no call for a probe: at most ${CALL_BUDGET} bridge calls per task`
    await writeShardSnapshot(ctx, { version: 2, shard, updatedAt: now().toISOString(), monitors: [], deliveries: [], capacityError })
    return idle(2)
  }
  const sites = shardSites(pollable, shard, destinations.length)
  if (sites.length === 0) {
    return idle(1)
  }
  const planned = plannedCalls(sites.length, reserved)
  const http = ctx.http
  if (!http) {
    throw new Error('ctx.http is unavailable: the plugin needs the network:request:unrestricted capability')
  }
  const hostFetch: NonNullable<PluginContext['http']>['fetch'] = (url, init) => http.fetch(url, init)
  let calls = 1

  const startedAt = now()
  const results = await Promise.all(sites.map(site => probeSite(hostFetch, site, deadlineMs, () => now().getTime())))
  calls += sites.length
  const real = results.filter(r => !r.limit)

  const today = dayOfDate(startedAt)
  const buckets = bucketsOf(ctx)
  const [existing, snapshots] = await Promise.all([
    buckets.getMany([...new Set([...touchedBucketIds(results), ...sites.map(site => bucketId(site.slug, today))])]),
    listSnapshots(ctx),
  ])
  calls += 2
  const previous = mergeSnapshots(snapshots)
  const staleConfigError = snapshots.some(entry => entry.key === CONFIG_ERROR_KEY)

  const changes = detectStatusChanges(real, previous.results)
  let deliveries: DeliveryOutcome[] = []
  if (changes.length > 0 && destinations.length > 0) {
    const messages = buildMessages(destinations, changes, now().toISOString())
    deliveries = await deliver(hostFetch, destinations, messages, deadlineMs)
    calls += messages.length
  }

  const changed = applyResults(existing, real)
  if (changed.length > 0) {
    await buckets.putMany(changed)
    calls += 1
  }
  const finishedAt = now()
  const effective = new Map([...existing, ...changed.map(({ id, data }) => [id, data] as const)])
  const monitors = results.map((result: CheckResult) => advanceMonitor(
    previous.monitors.get(result.slug),
    result,
    [...new Set([bucketId(result.slug, today), bucketId(result.slug, dayOf(result))])].flatMap(id => effective.get(id) ?? []),
    finishedAt,
  ))
  const snapshot: ShardSnapshot = { version: 2, shard, updatedAt: finishedAt.toISOString(), monitors, deliveries }
  await writeShardSnapshot(ctx, snapshot)
  calls += 1

  // The configuration validated, so an earlier error record is stale. Clear it when the budget has a call to spare;
  // a full shard leaves it to the maintenance task or the save, which also clear it.
  let plannedTotal = planned
  if (staleConfigError && calls < CALL_BUDGET) {
    await clearConfigError(ctx)
    calls += 1
    plannedTotal += 1
  }

  return { probed: sites.length, calls, planned: plannedTotal, unsupported: results.length - real.length, deliveries: deliveries.length }
}

/** Calls the daily prune may spend (one `query` and one `deleteMany`, twice), leaving the rest to the reconcile. */
const PRUNE_CALL_ALLOWANCE = 4

/**
 * The daily maintenance task: delete buckets that fell out of the 90-day
 * window, then converge the cron tasks on the configuration (finishing anything
 * an earlier reconcile left undone). Its own invocation gets its own budget.
 */
export async function runMaintenance(
  ctx: Pick<PluginContext, 'settings' | 'storage' | 'cron' | 'kv'>,
  options: { now?: () => Date } = {},
): Promise<{ deleted: number, calls: number }> {
  const now = options.now ?? (() => new Date())
  const pruned = await pruneExpiredBuckets(ctx, now(), PRUNE_CALL_ALLOWANCE)
  await reconcileShards(ctx, { budget: CALL_BUDGET - pruned.calls, clearConfigError: true })
  return { deleted: pruned.deleted, calls: pruned.calls }
}
