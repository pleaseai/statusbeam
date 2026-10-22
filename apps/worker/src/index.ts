import type { Env } from './env'
import type { NotificationMessage } from './notify'
import { checkSite, selectPollSites } from '@statusbeam/core'
import { ingest, loadConfig } from './ingest'
import { consumeNotificationBatch } from './notify'
import { handleWebhook } from './webhook'

/**
 * Worker entrypoints. Two triggers feed the same {@link ingest} pipeline:
 *
 * - `scheduled` (cron, wrangler.jsonc): check every configured site and ingest
 *   the whole batch. The reliable backstop.
 * - `fetch` (HTTP): accept inbound provider webhooks at
 *   `POST /webhooks/:provider/:slug` (Atlassian Statuspage or Sentry) and ingest
 *   a single site's status the moment it changes, instead of waiting for the next
 *   cron tick.
 *
 * Both persist the result, refresh the snapshot the status page reads, and — on
 * a status change — notify subscribers and purge the edge cache.
 *
 * A third, opt-in trigger drains notifications when `notifications.delivery` is
 * `queue`:
 *
 * - `queue` (Cloudflare Queues): dispatch each enqueued notification with the
 *   queue's automatic retries + dead-lettering. Inert unless the operator wires
 *   the `queues` bindings in wrangler.jsonc (Queues runs on the free plan; the
 *   Paid plan raises limits and retention).
 */
export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = await loadConfig(env)
    // Skip webhook-only Sentry sites and token-less Sentry poll sites: polling
    // them would record a false `down` every tick and clobber the webhook-driven
    // status; ingest preserves a skipped site's previous status instead.
    const sites = selectPollSites(config.sites, { sentryToken: env.SENTRY_AUTH_TOKEN })
    const results = await Promise.all(
      sites.map(site => checkSite(site, { sentryToken: env.SENTRY_AUTH_TOKEN })),
    )
    await ingest(env, config, results, ctx)
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWebhook(request, env, ctx)
  },

  async queue(batch: MessageBatch<NotificationMessage>, _env: Env, _ctx: ExecutionContext): Promise<void> {
    await consumeNotificationBatch(batch)
  },
}
