import type { PluginContext } from 'emdash/plugin'

/** The one task that probes every monitor. */
export const CHECK_TASK = 'check'
/** Cadence of {@link CHECK_TASK}; the 5-minute cadence works on both hosts. */
export const CHECK_SCHEDULE = '*/5 * * * *'

/** Daily housekeeping task: prunes history that fell out of the 90-day window. */
export const MAINTENANCE_TASK = 'maintenance'
export const MAINTENANCE_SCHEDULE = '17 3 * * *'

const WANTED: Record<string, string> = {
  [CHECK_TASK]: CHECK_SCHEDULE,
  [MAINTENANCE_TASK]: MAINTENANCE_SCHEDULE,
}

export interface ScheduleReconcile {
  scheduled: string[]
  cancelled: string[]
}

/**
 * Converge the plugin's cron tasks on the two it needs: create a missing task,
 * update one whose schedule changed, remove any other (left by an earlier
 * layout). Idempotent, and safe to call on every task run and on save.
 *
 * `ctx.cron.schedule()` is an upsert that moves the next run to the next match,
 * so it is called only for a task that is missing or changed. Calling it
 * unconditionally would keep postponing a task that a per-minute trigger polls,
 * and the task would never run.
 */
export async function reconcileSchedule(ctx: Pick<PluginContext, 'cron'>): Promise<ScheduleReconcile> {
  const cron = ctx.cron
  if (!cron) {
    throw new Error('ctx.cron is unavailable')
  }
  const existing = new Map((await cron.list()).map(task => [task.name, task.schedule]))
  const scheduled: string[] = []
  for (const [name, schedule] of Object.entries(WANTED)) {
    if (existing.get(name) !== schedule) {
      await cron.schedule(name, { schedule })
      scheduled.push(name)
    }
  }
  const cancelled: string[] = []
  for (const name of existing.keys()) {
    if (!(name in WANTED)) {
      await cron.cancel(name)
      cancelled.push(name)
    }
  }
  return { scheduled, cancelled }
}
