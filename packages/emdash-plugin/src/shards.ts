import type { Site, StatusConfig } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import { selectPollSites } from '@statusbeam/core'
import { CALL_BUDGET, MAX_SHARDS, monitorsPerTask, reservedCallsFor } from './budget'
import { clearConfigError, loadStoredConfig, recordConfigError } from './config'

/** Cadence of every shard task (FR-4: the 5-minute cadence works in all three execution modes). */
export const SHARD_SCHEDULE = '*/5 * * * *'

/** Daily housekeeping task: prunes expired buckets and converges the shard schedule. */
export const MAINTENANCE_TASK = 'maintenance'
export const MAINTENANCE_SCHEDULE = '17 3 * * *'

const SHARD_TASK_PATTERN = /^check-(\d+)$/

export function shardTaskName(shard: number): string {
  return `check-${shard}`
}

/** The shard index in a cron task name, or `null` when the name is not a shard task. */
export function parseShardTask(name: string): number | null {
  const match = SHARD_TASK_PATTERN.exec(name)
  return match ? Number(match[1]) : null
}

/** Monitors per shard under the call budget, once each of `destinations` notification destinations has its call reserved. */
export function monitorsPerShard(destinations = 0): number {
  return monitorsPerTask(reservedCallsFor(destinations))
}

/**
 * The monitors a scheduled run must actively check, ordered by slug so the
 * partition is deterministic. Webhook-only Sentry monitors are left out, and
 * so are Sentry poll monitors while no token is available (T008 supplies it).
 */
export function pollableSites(config: Pick<StatusConfig, 'sites'>, options: { sentryToken?: string } = {}): Site[] {
  return selectPollSites(config.sites, { sentryToken: options.sentryToken, warn: () => {} })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

/**
 * Shard tasks needed for `monitors` pollable monitors: `ceil(n / per-task)`,
 * capped at {@link MAX_SHARDS}. When the destinations leave no call for a probe,
 * one shard still runs to record the capacity error.
 */
export function shardCountFor(monitors: number, destinations = 0): number {
  const perShard = monitorsPerShard(destinations)
  if (monitors === 0) {
    return 0
  }
  return perShard < 1 ? 1 : Math.min(MAX_SHARDS, Math.ceil(monitors / perShard))
}

/**
 * The monitors shard `shard` checks: consecutive runs of {@link monitorsPerShard}
 * slugs from the sorted list, so each pollable monitor is in exactly one shard.
 * Monitors beyond `MAX_SHARDS * monitorsPerShard()` fall in no shard.
 */
export function shardSites(sorted: Site[], shard: number, destinations = 0): Site[] {
  const size = monitorsPerShard(destinations)
  return sorted.slice(shard * size, (shard + 1) * size)
}

interface TaskView {
  name: string
  schedule: string
}

export interface ReconcilePlan {
  schedule: Array<{ name: string, schedule: string, data?: Record<string, unknown> }>
  cancel: string[]
}

/**
 * Diff the wanted tasks against the existing ones. `shards` is the number of
 * shard tasks wanted, or `null` to leave shard tasks alone (no usable
 * configuration). A task whose cadence changed is scheduled again. The
 * maintenance task is always wanted. Cancels come last: they are only cleanup.
 */
export function planReconcile(shards: number | null, existing: TaskView[]): ReconcilePlan {
  const byName = new Map(existing.map(task => [task.name, task.schedule]))
  const wanted: ReconcilePlan['schedule'] = []
  if (shards !== null) {
    for (let shard = 0; shard < shards; shard++) {
      wanted.push({ name: shardTaskName(shard), schedule: SHARD_SCHEDULE, data: { shard } })
    }
  }
  wanted.push({ name: MAINTENANCE_TASK, schedule: MAINTENANCE_SCHEDULE })
  const schedule = wanted.filter(task => byName.get(task.name) !== task.schedule)
  const cancel = shards === null
    ? []
    : existing.filter((task) => {
        const shard = parseShardTask(task.name)
        return shard !== null && shard >= shards
      }).map(task => task.name)
  return { schedule, cancel }
}

export interface ReconcileResult {
  /** Shard tasks the configuration needs, or `null` when there was no usable configuration. */
  shards: number | null
  scheduled: string[]
  cancelled: string[]
  /** Operations left undone because the invocation's call budget ran out; the daily maintenance task finishes them. */
  deferred: number
  /** Pollable monitors beyond the shard cap, which no task checks. */
  uncovered: number
}

/**
 * Converge the plugin's cron tasks on the configuration: schedule the missing
 * shard tasks (and the maintenance task), cancel the surplus ones. Idempotent.
 *
 * It spends at most `budget` bridge calls (default {@link CALL_BUDGET}): one to
 * read the settings (the configuration and the destinations that size the shards), one to list tasks, one to record or clear the
 * configuration error when the configuration is invalid or `clearConfigError` is set, then one per schedule or cancel.
 * Missing tasks go first so coverage comes before cleanup. Call it from
 * `plugin:activate`, and after a successful configuration save with `{ clearConfigError: true }`.
 */
export async function reconcileShards(
  ctx: Pick<PluginContext, 'settings' | 'cron' | 'kv'>,
  options: { budget?: number, clearConfigError?: boolean } = {},
): Promise<ReconcileResult> {
  const cron = ctx.cron
  if (!cron) {
    throw new Error('ctx.cron is unavailable')
  }
  const budget = options.budget ?? CALL_BUDGET
  const stored = await loadStoredConfig(ctx)
  const config = stored.status === 'valid' ? stored.config : null
  const destinations = stored.status === 'valid' ? stored.destinations : []
  const sentryToken = stored.status === 'valid' ? stored.sentryToken : undefined
  const monitors = config ? pollableSites(config, { sentryToken }).length : 0
  const shards = config ? shardCountFor(monitors, destinations.length) : null
  const plan = planReconcile(shards, await cron.list())

  const scheduled: string[] = []
  const cancelled: string[] = []
  let remaining = Math.max(0, budget - 2)
  // An invalid stored configuration is recorded for the admin page and leaves the shard tasks alone.
  // A save clears an earlier record (the caller passes `clearConfigError`); each takes one call.
  if (stored.status === 'invalid') {
    await recordConfigError(ctx, stored.issues, new Date())
    remaining = Math.max(0, remaining - 1)
  }
  else if (stored.status === 'valid' && options.clearConfigError) {
    await clearConfigError(ctx)
    remaining = Math.max(0, remaining - 1)
  }
  for (const task of plan.schedule) {
    if (remaining === 0) {
      break
    }
    await cron.schedule(task.name, { schedule: task.schedule, ...(task.data ? { data: task.data } : {}) })
    scheduled.push(task.name)
    remaining -= 1
  }
  for (const name of plan.cancel) {
    if (remaining === 0) {
      break
    }
    await cron.cancel(name)
    cancelled.push(name)
    remaining -= 1
  }
  return {
    shards,
    scheduled,
    cancelled,
    deferred: plan.schedule.length + plan.cancel.length - scheduled.length - cancelled.length,
    uncovered: Math.max(0, monitors - MAX_SHARDS * monitorsPerShard(destinations.length)),
  }
}
