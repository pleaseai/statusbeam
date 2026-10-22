import type { SandboxedPlugin } from 'emdash/plugin'
import { PROBE_DEADLINE_MS } from './budget'
import { runMaintenance, runShard } from './run'
import { MAINTENANCE_TASK, parseShardTask, reconcileShards } from './shards'

/**
 * A shorter per-probe deadline from the task's own `data`, never a longer one.
 * Only this plugin schedules its tasks, so the value is not attacker-supplied;
 * it exists so tests can exercise the deadline without waiting 10 s.
 */
function deadlineFrom(data: Record<string, unknown> | undefined): number {
  const requested = data?.deadlineMs
  return typeof requested === 'number' && requested > 0 ? Math.min(requested, PROBE_DEADLINE_MS) : PROBE_DEADLINE_MS
}

/**
 * The StatusBeam engine as a sandboxed EmDash plugin (ADR-0004).
 *
 * Seams for later tasks: notifications (T005) extend `runShard`; the public
 * routes (T006) read `readSnapshot` and the buckets; webhooks (T007) and the
 * admin page (T009) add `routes`, and T009 calls `reconcileShards` after a save.
 */
const plugin: SandboxedPlugin = {
  hooks: {
    // Also runs after first install, so one hook covers install and re-enable.
    'plugin:activate': async (_event, ctx) => {
      await reconcileShards(ctx)
    },
    'cron': async (event, ctx) => {
      if (event.name === MAINTENANCE_TASK) {
        await runMaintenance(ctx)
        return
      }
      const shard = parseShardTask(event.name)
      if (shard !== null) {
        await runShard(ctx, shard, { deadlineMs: deadlineFrom(event.data) })
      }
    },
  },
}

export default plugin
