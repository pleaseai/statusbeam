import type { CheckResult } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'

const SNAPSHOT_PREFIX = 'snapshot:'

/**
 * What one shard task leaves in `ctx.kv`: the latest result of each monitor it
 * checked. Each shard owns its own key, so concurrent shard tasks never
 * read-modify-write the same value.
 */
export interface ShardSnapshot {
  version: 1
  shard: number
  /** ISO time the shard finished its run. */
  updatedAt: string
  results: CheckResult[]
}

export function snapshotKey(shard: number): string {
  return `${SNAPSHOT_PREFIX}${shard}`
}

/** Write a shard's snapshot (one bridge call). */
export async function writeShardSnapshot(
  ctx: Pick<PluginContext, 'kv'>,
  shard: number,
  results: CheckResult[],
  now: Date,
): Promise<void> {
  const snapshot: ShardSnapshot = { version: 1, shard, updatedAt: now.toISOString(), results }
  await ctx.kv.set(snapshotKey(shard), snapshot)
}

export interface MergedSnapshot {
  /** Latest known result per monitor slug, across every shard. */
  results: Map<string, CheckResult>
  /** The newest shard `updatedAt`, or `null` before any shard has run. */
  updatedAt: string | null
}

/**
 * Merge every shard snapshot into one view (one bridge call: a prefix list).
 * When a monitor appears in more than one snapshot, which happens briefly after
 * a configuration change moves it between shards, the newest check wins.
 * Readers (the public routes, T006) use this instead of knowing the shard layout.
 */
export async function readSnapshot(ctx: Pick<PluginContext, 'kv'>): Promise<MergedSnapshot> {
  const entries = await ctx.kv.list(SNAPSHOT_PREFIX)
  const results = new Map<string, CheckResult>()
  let updatedAt: string | null = null
  for (const entry of entries) {
    const snapshot = entry.value as ShardSnapshot | null
    if (!snapshot || !Array.isArray(snapshot.results)) {
      continue
    }
    if (updatedAt === null || snapshot.updatedAt > updatedAt) {
      updatedAt = snapshot.updatedAt
    }
    for (const result of snapshot.results) {
      const known = results.get(result.slug)
      if (!known || result.checkedAt > known.checkedAt) {
        results.set(result.slug, result)
      }
    }
  }
  return { results, updatedAt }
}
