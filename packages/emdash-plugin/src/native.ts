import type { HttpAccess, PluginContext } from 'emdash'
import { createUnrestrictedHttpAccess, definePlugin } from 'emdash'
import pkg from '../package.json' with { type: 'json' }
import { PLUGIN_ID } from './descriptor'
import { createProbeHttp } from './http'
import { adminRoutes } from './routes/admin'
import { publicRoutes } from './routes/public'
import { webhookRoutes } from './routes/webhooks'
import { runCheck, runMaintenance } from './run'
import { CHECK_TASK, MAINTENANCE_TASK, reconcileSchedule } from './schedule'
import { SENTRY_TOKEN_SECRET_KEY, SLACK_SECRET_KEY, WEBHOOK_SECRET_KEY, WEBHOOKS_SECRET_KEY } from './settings'

/**
 * The native plugin (ADR-0005). The descriptor's `entrypoint`: EmDash imports
 * `createPlugin` from here and calls it with the descriptor's `options`. It runs
 * in `plugins: []`, with no sandbox runner.
 *
 * One 5-minute `check` task probes every monitor; a daily `maintenance` task
 * prunes history. The public, webhook and admin routes are here; the admin
 * pages (T005 to T007) are added by later tasks.
 */

/**
 * Timeout for the `cron` hook. EmDash's default hook timeout is 5 s, which ends
 * a run whose slowest probe takes longer and drops all of its writes. A run
 * needs the probe deadline plus its reads and writes.
 */
export const CRON_HOOK_TIMEOUT_MS = 25_000

const SETTINGS_SCHEMA = {
  [SLACK_SECRET_KEY]: {
    type: 'secret',
    label: 'Slack webhook URL',
    description: 'Incoming-webhook URL. Status changes post here.',
  },
  [WEBHOOKS_SECRET_KEY]: {
    type: 'secret',
    label: 'Generic webhook URLs',
    description: 'One URL per line, or separated by commas or spaces. Each receives the status-change JSON.',
  },
  [WEBHOOK_SECRET_KEY]: {
    type: 'secret',
    label: 'Webhook secret',
    description: 'Shared token for inbound Statuspage and Sentry webhooks, sent as ?token=. While unset, every inbound webhook is rejected.',
  },
  [SENTRY_TOKEN_SECRET_KEY]: {
    type: 'secret',
    label: 'Sentry auth token',
    description: 'Lets monitors with a Sentry poll backstop read the Issues API. Separate from the webhook secret. Without it, only webhooks update those monitors.',
  },
} as const

/** What a test can replace. The site cannot: `createPlugin` is called with JSON options only. */
export interface NativePluginDeps {
  /**
   * The `fetch` under the host's SSRF guard, for header-only probes and for
   * every other outbound request. The guard itself always runs.
   */
  fetchImpl?: typeof fetch
  now?: () => Date
  deadlineMs?: number
}

/**
 * Converge the cron tasks on the two this plugin needs. A failure is logged and
 * never ends the run it rides on: the next run reconciles again.
 */
async function reconcile(ctx: PluginContext): Promise<void> {
  try {
    await reconcileSchedule(ctx)
  }
  catch (error) {
    ctx.log.warn('statusbeam: could not reconcile the scheduled tasks', { error: error instanceof Error ? error.message : String(error) })
  }
}

export function createNativePlugin(deps: NativePluginDeps = {}) {
  const probeHttp: HttpAccess = createProbeHttp(PLUGIN_ID, deps.fetchImpl)
  // Without an injected `fetch` the host's own `ctx.http` serves body reads and deliveries.
  const bodyHttp = deps.fetchImpl ? createUnrestrictedHttpAccess(PLUGIN_ID, deps.fetchImpl) : undefined
  return definePlugin({
    id: PLUGIN_ID,
    version: pkg.version,
    capabilities: ['network:request:unrestricted'],
    storage: { buckets: { indexes: ['date', ['slug', 'date']] } },
    hooks: {
      // Also runs after first install, so one hook covers install and re-enable.
      'plugin:activate': async (_event, ctx) => {
        await reconcile(ctx)
      },
      'cron': {
        timeout: CRON_HOOK_TIMEOUT_MS,
        handler: async (event, ctx) => {
          if (event.name !== CHECK_TASK && event.name !== MAINTENANCE_TASK) {
            return
          }
          await reconcile(ctx)
          const options = { probeHttp, ...(bodyHttp ? { bodyHttp } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) }
          if (event.name === MAINTENANCE_TASK) {
            await runMaintenance(ctx, options)
          }
          else {
            await runCheck(ctx, options)
          }
        },
      },
    },
    routes: {
      ...publicRoutes,
      ...adminRoutes({ probeHttp, ...(bodyHttp ? { bodyHttp } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) }),
      ...webhookRoutes({ ...(bodyHttp ? { http: bodyHttp } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) }),
    },
    admin: {
      entry: '@statusbeam/emdash-plugin/admin',
      pages: [
        { path: '/', label: 'Status', icon: 'chart-line' },
        { path: '/monitors', label: 'Monitors', icon: 'list' },
      ],
      widgets: [{ id: 'status', title: 'StatusBeam', size: 'half' }],
      // Notification destinations and tokens live in encrypted settings, never in the YAML: a webhook URL embeds its credential.
      settingsSchema: SETTINGS_SCHEMA,
    },
  })
}

export function createPlugin(_options: Record<string, unknown> = {}) {
  return createNativePlugin()
}
