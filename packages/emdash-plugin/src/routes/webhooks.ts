import type { CheckResult, WebhookProvider } from '@statusbeam/core'
import type { PluginContext, PluginResponse, RouteEntry, SandboxedRouteContext } from 'emdash/plugin'
import type { DeliveryOutcome } from '../notify'
import { detectStatusChanges, gradeWebhookPayload, timingSafeEqual, webhookProviderMatchesSite } from '@statusbeam/core'
import { pluginResponse } from 'emdash/plugin'
import { applyResults, bucketId, bucketsOf } from '../buckets'
import { CALL_BUDGET, PROBE_DEADLINE_MS } from '../budget'
import { readSettings } from '../config'
import { buildMessages, deliver } from '../notify'
import { advanceMonitor, listSnapshots, mergeSnapshots, writeWebhookSnapshot } from '../snapshot'

/**
 * Inbound Statuspage and Sentry webhooks as public plugin routes (FR-11).
 *
 * EmDash matches a route by its exact name, so the standalone worker's
 * `/webhooks/:provider/:slug` becomes one route per provider with the slug in
 * the query: `POST /_emdash/api/plugins/statusbeam/webhooks/{statuspage|sentry}?slug=<slug>&token=<secret>`.
 *
 * `public: true` removes the host's authentication, so the route keeps the
 * standalone endpoint's: it rejects every request while no secret is set and
 * compares `?token=` in constant time. The body is declared `text`, so the host
 * does not parse it; this route parses it only after the token matched.
 */
export const WEBHOOK_ROUTE_PREFIX = 'webhooks/'

/** Largest webhook body the host reads (provider payloads are a few KiB). */
const MAX_BODY_BYTES = 262_144

/**
 * Bridge calls a webhook makes besides notifications: settings.list,
 * storage.getMany, kv.list, storage.putMany, kv.set.
 */
export const WEBHOOK_FIXED_CALLS = 5

/** Destinations one webhook can notify within the invocation's call budget. */
export const WEBHOOK_MAX_DESTINATIONS = CALL_BUDGET - WEBHOOK_FIXED_CALLS

export interface WebhookOptions {
  now?: () => Date
  deadlineMs?: number
}

type WebhookContext = Pick<PluginContext, 'settings' | 'kv' | 'storage' | 'http'>

function reply(status: number, text: string | null, headers: Record<string, string> = {}): PluginResponse {
  return pluginResponse({ status, headers, body: text === null ? null : { kind: 'text', value: text } })
}

/** The query of the request URL; the sandboxed request carries an absolute URL. */
function queryOf(request: SandboxedRouteContext['request']): URLSearchParams {
  return new URL(request.url, 'https://plugin.invalid').searchParams
}

/**
 * Handle one inbound webhook. Rejections come in a fixed order, and none of them
 * touches storage or grades a body: method (405), then no secret configured
 * (401), then token mismatch (401). Only a request that passed all three reads
 * the body or any storage.
 *
 * A graded event is stored like a polled result, but in webhook-owned records:
 * it increments only the `webhook` bucket row of today, and writes only the
 * webhook's own `snapshot:webhook:{slug}` key (latest result plus day stats of
 * webhook events). A shard never writes either, and this never writes a shard
 * key or a poll row, so an event arriving during a cron run cannot overwrite or
 * lose that run's counts or result. Readers add the two sources when they
 * merge (see `mergeSnapshots`). Two webhooks for the same slug in the same
 * instant can still race on their own row and key, and one of the two counts can
 * be lost; webhooks are sparse events, so that is accepted.
 *
 * A status change posts to the destinations like a polled one. A webhook
 * spends 5 calls plus one per destination; with more destinations than fit in
 * the 10-call budget the change is recorded and `deliverySkipped: 'capacity'`
 * marks that it was not announced.
 */
export async function handleWebhook(
  provider: WebhookProvider,
  routeCtx: Pick<SandboxedRouteContext, 'input' | 'request'>,
  ctx: WebhookContext,
  options: WebhookOptions = {},
): Promise<PluginResponse> {
  if (routeCtx.request.method.toUpperCase() !== 'POST') {
    return reply(405, 'Method not allowed', { Allow: 'POST' })
  }
  const settings = await readSettings(ctx)
  const query = queryOf(routeCtx.request)
  if (!settings.webhookSecret || !timingSafeEqual(query.get('token') ?? '', settings.webhookSecret)) {
    return reply(401, 'Unauthorized')
  }

  const slug = query.get('slug') ?? ''
  const site = settings.config?.sites.find(s => s.slug === slug)
  if (!site || !webhookProviderMatchesSite(provider, site)) {
    return reply(404, 'Unknown site')
  }

  let body: unknown
  try {
    body = JSON.parse(String(routeCtx.input))
  }
  catch {
    return reply(400, 'Invalid JSON')
  }
  const graded = gradeWebhookPayload(provider, body, site)
  if ('error' in graded) {
    // As in the standalone Worker: payload drift (a provider API change) is logged with the Zod reason,
    // and the caller gets the bare 400. `console` costs no bridge call, unlike `ctx.log`.
    console.warn(`webhook: payload failed validation for slug "${slug}": ${graded.reason}`)
    return reply(400, 'Invalid payload')
  }
  if (graded.status === null) {
    return reply(204, null)
  }

  const now = options.now ?? (() => new Date())
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS
  const result: CheckResult = { slug: site.slug, status: graded.status, code: 200, responseTime: 0, checkedAt: now().toISOString() }
  const rowId = bucketId(site.slug, result.checkedAt.slice(0, 10), 'webhook')
  const buckets = bucketsOf(ctx)
  const [existing, snapshots] = await Promise.all([buckets.getMany([rowId]), listSnapshots(ctx)])
  const previous = mergeSnapshots(snapshots)

  const changes = detectStatusChanges([result], previous.results)
  let deliveries: DeliveryOutcome[] = []
  let deliverySkipped: 'capacity' | undefined
  if (changes.length > 0 && settings.destinations.length > 0) {
    if (settings.destinations.length > WEBHOOK_MAX_DESTINATIONS) {
      deliverySkipped = 'capacity'
    }
    else {
      const http = ctx.http
      if (!http) {
        throw new Error('ctx.http is unavailable: the plugin needs the network:request:unrestricted capability')
      }
      const messages = buildMessages(settings.destinations, changes, result.checkedAt)
      deliveries = await deliver((url, init) => http.fetch(url, init), settings.destinations, messages, deadlineMs)
    }
  }

  const changed = applyResults(existing, [result], 'webhook')
  await buckets.putMany(changed)
  const monitor = advanceMonitor(previous.pushed.get(site.slug), result, changed.map(row => row.data), now())
  await writeWebhookSnapshot(ctx, {
    version: 2,
    webhook: true,
    slug: site.slug,
    updatedAt: now().toISOString(),
    monitor,
    deliveries,
    ...(deliverySkipped ? { deliverySkipped } : {}),
  })
  return reply(200, 'OK')
}

function webhookRoute(provider: WebhookProvider): RouteEntry {
  return {
    public: true,
    methods: ['POST'],
    response: 'raw',
    request: { body: 'text', maxBytes: MAX_BODY_BYTES },
    handler: (routeCtx, ctx) => handleWebhook(provider, routeCtx, ctx),
  }
}

export const webhookRoutes: Record<string, RouteEntry> = {
  [`${WEBHOOK_ROUTE_PREFIX}statuspage`]: webhookRoute('statuspage'),
  [`${WEBHOOK_ROUTE_PREFIX}sentry`]: webhookRoute('sentry'),
}
