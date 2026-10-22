import type { PluginContext } from 'emdash/plugin'
import { applyResults, bucketsOf, pruneExpiredBuckets, touchedBucketIds } from './buckets'
import { CALL_BUDGET, monitorsPerTask, PROBE_DEADLINE_MS, SHARD_FIXED_CALLS, SHARD_RESERVED_CALLS } from './budget'
import { probeSite } from './probe'
import { readConfig } from './settings'
import { pollableSites, reconcileShards, shardSites } from './shards'
import { writeShardSnapshot } from './snapshot'

type RunContext = Pick<PluginContext, 'settings' | 'kv' | 'storage' | 'http'>

export interface ShardRunOptions {
  now?: () => Date
  /** Per-probe deadline in ms. */
  deadlineMs?: number
  /** Calls to set aside for work beyond probing and the fixed calls. */
  reservedCalls?: number
}

export interface ShardRunResult {
  /** Monitors probed. */
  probed: number
  /** Monitors in the shard that the call budget could not afford; they keep their last status. */
  skipped: number
  /** Bridge calls the run made. */
  calls: number
}

/**
 * One shard task: probe the shard's monitors through `ctx.http.fetch`, add the
 * outcomes to the per-day buckets, and write the shard snapshot.
 *
 * It makes {@link SHARD_FIXED_CALLS} fixed bridge calls plus one fetch per
 * monitor and never calls `ctx.log`, so a full shard stays within
 * {@link CALL_BUDGET}. The call count is planned before the first probe starts:
 * a monitor the budget cannot afford is skipped, not started. Probes run
 * concurrently, each under its own deadline, so one hung target costs at most the
 * deadline and the others still finish.
 *
 * An absent or invalid configuration, or an empty shard, checks nothing and
 * writes nothing. All writes come last, so an invocation the runtime kills
 * leaves the buckets and the snapshot as they were.
 */
export async function runShard(ctx: RunContext, shard: number, options: ShardRunOptions = {}): Promise<ShardRunResult> {
  const now = options.now ?? (() => new Date())
  const reserved = options.reservedCalls ?? SHARD_RESERVED_CALLS
  let calls = 0

  const config = await readConfig(ctx)
  calls += 1
  if (!config) {
    return { probed: 0, skipped: 0, calls }
  }

  const assigned = shardSites(pollableSites(config), shard)
  const affordable = Math.max(0, monitorsPerTask(reserved))
  const sites = assigned.slice(0, affordable)
  if (sites.length === 0) {
    return { probed: 0, skipped: assigned.length, calls }
  }

  const http = ctx.http
  if (!http) {
    throw new Error('ctx.http is unavailable: the plugin needs the network:request:unrestricted capability')
  }
  const results = await Promise.all(
    sites.map(site => probeSite((url, init) => http.fetch(url, init), site, options.deadlineMs ?? PROBE_DEADLINE_MS)),
  )
  calls += sites.length

  const buckets = bucketsOf(ctx)
  const existing = await buckets.getMany(touchedBucketIds(results))
  calls += 1
  await buckets.putMany(applyResults(existing, results))
  calls += 1
  await writeShardSnapshot(ctx, shard, results, now())
  calls += 1

  return { probed: sites.length, skipped: assigned.length - sites.length, calls }
}

/** Calls the daily prune may spend (one `query` and one `deleteMany`, twice), leaving the rest to the reconcile. */
const PRUNE_CALL_ALLOWANCE = 4

/**
 * The daily maintenance task: delete buckets that fell out of the 90-day
 * window, then converge the cron tasks on the configuration (finishing anything
 * an earlier reconcile left undone). Its own invocation gets its own budget.
 */
export async function runMaintenance(
  ctx: Pick<PluginContext, 'settings' | 'storage' | 'cron'>,
  options: { now?: () => Date } = {},
): Promise<{ deleted: number, calls: number }> {
  const now = options.now ?? (() => new Date())
  const pruned = await pruneExpiredBuckets(ctx, now(), PRUNE_CALL_ALLOWANCE)
  await reconcileShards(ctx, { budget: CALL_BUDGET - pruned.calls })
  return { deleted: pruned.deleted, calls: pruned.calls }
}
