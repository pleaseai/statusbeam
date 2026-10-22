/**
 * The bridge-call budget model (ADR-0004, "Capacity per run").
 *
 * Under Cloudflare Worker Loader every bridge call a sandboxed plugin makes
 * (`ctx.http.fetch`, `ctx.kv.*`, `ctx.storage.*`, `ctx.settings.*`, `ctx.log.*`)
 * counts against one 10-subrequest budget per invocation, and calls past the
 * 10th reject. The spike measured `http`, `kv`, `log` and `storage.putMany`;
 * `settings` and `cron` calls are assumed to count too (unverified), so the
 * model counts them.
 *
 * A shard task spends its budget on three things: a fixed overhead, one call per
 * configured notification destination (reserved in every shard, whether or not a
 * status changed), and one probe per monitor. Every number the scheduling code
 * needs derives from this module.
 */

/** Bridge calls one invocation may make before the host starts rejecting them. */
export const CALL_BUDGET = 10

/**
 * Calls every shard task spends regardless of its monitor count:
 * read the settings (1: `settings.list` returns the configuration and the
 * encrypted secrets together), read today's buckets (1), read the snapshots (1),
 * write the buckets with one `putMany` (1), write the shard snapshot (1).
 */
export const SHARD_FIXED_CALLS = 5

/** Plugin-side deadline for one probe or delivery, so a never-completing response cannot end the invocation (ADR-0004 Decision 4). */
export const PROBE_DEADLINE_MS = 10_000

/**
 * The scheduler claims at most this many due tasks per tick across the whole
 * site (`LIMIT 10` in `CronExecutor.tick`), and runs them one after another.
 */
export const SCHEDULER_CLAIM_LIMIT = 10

/**
 * Upper bound on shard tasks. It leaves headroom under {@link SCHEDULER_CLAIM_LIMIT}
 * for the daily maintenance task and for tasks other plugins schedule.
 */
export const MAX_SHARDS = 8

/**
 * Calls a shard task sets aside for notifications: at most one delivery per
 * destination per run, carrying every status change of that shard. The call is
 * reserved in every shard, so a shard never has to choose between a probe and
 * an alert.
 */
export function reservedCallsFor(destinations: number): number {
  return Math.max(0, destinations)
}

/** Probes one task can afford once `reservedCalls` are set aside for other work (notification deliveries). */
export function monitorsPerTask(reservedCalls = 0): number {
  return Math.max(0, CALL_BUDGET - SHARD_FIXED_CALLS - reservedCalls)
}

/** Bridge calls a shard task makes for `probes` monitors, plus `reservedCalls` for other work. */
export function plannedCalls(probes: number, reservedCalls = 0): number {
  return SHARD_FIXED_CALLS + probes + reservedCalls
}

/** Whether a task with `probes` monitors and `reservedCalls` stays within {@link CALL_BUDGET}. */
export function fitsBudget(probes: number, reservedCalls = 0): boolean {
  return plannedCalls(probes, reservedCalls) <= CALL_BUDGET
}
