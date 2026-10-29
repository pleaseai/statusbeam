import type { Site } from '@statusbeam/core'
import type { HttpAccess } from 'emdash'
import type { PluginContext } from 'emdash/plugin'
import type { DeliveryOutcome } from './notify'
import type { PollSnapshot } from './snapshot'
import { detectStatusChanges, selectPollSites } from '@statusbeam/core'
import { applyResults, bucketId, bucketsOf, dayOf, pruneExpiredBuckets, touchedBucketIds, utcDay } from './buckets'
import { clearConfigError, CONFIG_ERROR_KEY, loadStoredConfig, recordConfigError } from './config'
import { PLUGIN_ID } from './descriptor'
import { createProbeHttp } from './http'
import { buildMessages, deliver } from './notify'
import { PROBE_DEADLINE_MS, probeSite } from './probe'
import { advanceMonitor, listSnapshots, mergeSnapshots, writePollSnapshot } from './snapshot'

type RunContext = Pick<PluginContext, 'settings' | 'kv' | 'storage' | 'http'>

export interface CheckRunOptions {
  now?: () => Date
  /** Per-probe and per-delivery deadline in ms. */
  deadlineMs?: number
  /**
   * The client for plain HTTP checks: headers only, behind the host's SSRF
   * guard. Defaults to {@link createProbeHttp}; tests pass a stand-in.
   */
  probeHttp?: Pick<HttpAccess, 'fetch'>
  /** The client for checks that read a body and for notification deliveries. Defaults to `ctx.http`. */
  bodyHttp?: Pick<HttpAccess, 'fetch'>
}

export interface CheckRunResult {
  /** Monitors probed. */
  probed: number
  /** Deliveries attempted (zero when nothing changed). */
  deliveries: number
}

/** Check types that read the response body, so they cannot use the header-only client. */
export const BODY_CHECKS = new Set<string>(['statuspage', 'incidentio', 'sentry', 'aigateway'])

/**
 * The monitors a scheduled run must actively check, ordered by slug so the
 * snapshot is deterministic. Webhook-only Sentry monitors are left out, and so
 * are Sentry poll monitors while no token is available.
 */
export function pollableSites(sites: Site[], options: { sentryToken?: string } = {}): Site[] {
  return selectPollSites(sites, { sentryToken: options.sentryToken, warn: () => {} })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

/**
 * The scheduled check: probe every monitor, notify the destinations of status
 * changes, add the outcomes to the per-day buckets, and write the snapshot.
 *
 * All monitors are probed at once, each under its own deadline, so one hung
 * response is `down` at the deadline and delays no other. Plain HTTP checks
 * time the response headers (`probeHttp`); checks that read a body use
 * `ctx.http.fetch`. The order is settings, probes, reads, deliveries, then the
 * two writes. A run the runtime ends before the writes leaves the buckets and
 * the snapshot as they were: the next run sees the same previous status and
 * tells the destinations again, which is a duplicate message, never a lost one.
 *
 * The monitors probed are the ones in the stored configuration at the start of
 * the run, so a monitor removed from it is neither probed nor kept in the new
 * snapshot. A probe that hit the host's body limit says nothing about the
 * target: it is not counted in the buckets, not compared for change detection,
 * and does not replace the monitor's last result. An absent or invalid configuration checks nothing and writes
 * nothing (an invalid one leaves a configuration-error record).
 */
export async function runCheck(ctx: RunContext, options: CheckRunOptions = {}): Promise<CheckRunResult> {
  const now = options.now ?? (() => new Date())
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS
  const idle: CheckRunResult = { probed: 0, deliveries: 0 }

  const stored = await loadStoredConfig(ctx)
  if (stored.status === 'absent') {
    return idle
  }
  if (stored.status === 'invalid') {
    await recordConfigError(ctx, stored.issues, now())
    return idle
  }
  const { config, destinations, sentryToken } = stored
  const sites = pollableSites(config.sites, { sentryToken })
  const http = options.bodyHttp ?? ctx.http
  if (!http) {
    throw new Error('ctx.http is unavailable: the plugin needs the network:request:unrestricted capability')
  }
  const probeHttp = options.probeHttp ?? createProbeHttp(PLUGIN_ID)
  const bodyFetch: typeof http.fetch = (url, init) => http.fetch(url, init)
  const headerFetch: typeof http.fetch = (url, init) => probeHttp.fetch(url, init)

  const startedAt = now()
  const results = await Promise.all(sites.map(site =>
    probeSite(BODY_CHECKS.has(site.check) ? bodyFetch : headerFetch, site, deadlineMs, () => now().getTime(), sentryToken)))

  const real = results.filter(result => !result.limit)

  const today = utcDay(startedAt.toISOString())
  const buckets = bucketsOf(ctx)
  const [existing, entries] = await Promise.all([
    buckets.getMany([...new Set([...touchedBucketIds(results), ...sites.map(site => bucketId(site.slug, today))])]),
    listSnapshots(ctx),
  ])
  const previous = mergeSnapshots(entries)

  const changes = detectStatusChanges(real, previous.results)
  let deliveries: DeliveryOutcome[] = []
  if (changes.length > 0 && destinations.length > 0) {
    deliveries = await deliver(bodyFetch, destinations, buildMessages(destinations, changes, now().toISOString()), deadlineMs)
  }

  const changed = applyResults(existing, real)
  if (changed.length > 0) {
    await buckets.putMany(changed)
  }
  const finishedAt = now()
  const effective = new Map([...existing, ...changed.map(({ id, data }) => [id, data] as const)])
  const monitors = results.flatMap((result) => {
    if (result.limit) {
      const kept = previous.polled.get(result.slug)
      return kept ? [kept] : []
    }
    return [advanceMonitor(
      // Poll-only state: webhook counts live in the webhook's own key and are added when readers merge.
      previous.polled.get(result.slug),
      result,
      [...new Set([bucketId(result.slug, today), bucketId(result.slug, dayOf(result))])].flatMap(id => effective.get(id) ?? []),
      finishedAt,
    )]
  })
  // A Sentry poll monitor skipped for want of a token keeps its last poll state, so restoring the token
  // resumes from it. Webhook-only Sentry monitors have no poll state to keep: their webhook snapshot is
  // merged by readers. A monitor removed from the configuration is not carried.
  const probedSlugs = new Set(sites.map(site => site.slug))
  const carried = config.sites.flatMap((site) => {
    const kept = !probedSlugs.has(site.slug) && site.check === 'sentry' && site.sentry !== undefined ? previous.polled.get(site.slug) : undefined
    return kept ? [kept] : []
  })
  const snapshot: PollSnapshot = { version: 2, updatedAt: finishedAt.toISOString(), monitors: [...monitors, ...carried], deliveries }
  await writePollSnapshot(ctx, snapshot)

  // The configuration validated, so an earlier error record is stale.
  if (entries.some(entry => entry.key === CONFIG_ERROR_KEY)) {
    await clearConfigError(ctx)
  }
  return { probed: sites.length, deliveries: deliveries.length }
}

/** The daily maintenance task: delete buckets that fell out of the 90-day window. */
export async function runMaintenance(
  ctx: Pick<PluginContext, 'storage'>,
  options: { now?: () => Date } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? (() => new Date())
  return { deleted: await pruneExpiredBuckets(ctx, now()) }
}
