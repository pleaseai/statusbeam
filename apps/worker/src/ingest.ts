import type { CheckResult, DayCounts, DayStat, SiteSummary, StatusConfig } from '@statusbeam/core'
import type { Env } from './env'
import { buildSiteSummaries, buildStatusChangePayload, detectStatusChanges, groupDayStats, historyWindowStart, parseConfig } from '@statusbeam/core'
import { purgeStatusCache } from './cache'
import { KV_KEYS } from './env'
import { notify } from './notify'

/** Load and parse the `status.config.yml` document from KV. Throws if absent. */
export async function loadConfig(env: Env): Promise<StatusConfig> {
  const yaml = await env.STATUS_KV.get(KV_KEYS.config)
  if (!yaml) {
    throw new Error('No config in KV. Upload status.config.yml to the "config" key.')
  }
  return parseConfig(yaml)
}

/**
 * The shared ingest pipeline for a batch of {@link CheckResult}s, regardless of
 * how they were produced — the cron loop (every site) or an inbound Statuspage
 * webhook (one site). Persists each check row, refreshes the snapshot the status
 * page reads, and — on a status change — notifies subscribers and purges the edge
 * cache so the page updates immediately instead of waiting for a TTL.
 *
 * Safe for a *partial* batch: sites absent from `results` keep their previous
 * status in the rewritten summary (see {@link writeSummary}), so a single-site
 * webhook update never blanks the other sites.
 */
export async function ingest(
  env: Env,
  config: StatusConfig,
  results: CheckResult[],
  ctx: ExecutionContext,
): Promise<void> {
  // Persist every check row (time-series) in one batch.
  await env.DB.batch(
    results.map(r =>
      env.DB.prepare(
        `INSERT INTO checks (slug, status, code, response_time, checked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(r.slug, r.status, r.code, r.responseTime, r.checkedAt),
    ),
  )

  // Detect status changes against the previous snapshot before overwriting it.
  const previous = await readSummary(env)
  const changes = detectStatusChanges(results, previous)

  const now = new Date()
  await writeSummary(env, config, results, previous, now)

  if (changes.length > 0) {
    const payload = buildStatusChangePayload(changes, now.toISOString())

    // Notify subscribers and purge the edge cache by tag so the page reflects
    // the new state immediately instead of waiting for its TTL. `notify` picks
    // inline `fetch` or the opt-in Cloudflare Queue from `notifications.delivery`.
    ctx.waitUntil(notify(env, config.notifications, payload))
    ctx.waitUntil(purgeStatusCache(env, changes.map(c => c.slug)))
  }
}

/** Read the previous snapshot as slug → summary for change detection and fallback. */
async function readSummary(env: Env): Promise<Map<string, SiteSummary>> {
  const raw = await env.STATUS_KV.get(KV_KEYS.summary)
  if (!raw) {
    return new Map()
  }
  const summary = JSON.parse(raw) as SiteSummary[]
  return new Map(summary.map(s => [s.slug, s]))
}

/**
 * Overwrite the snapshot the status page reads at the edge. `results` may cover
 * only some sites (a webhook updates one); any site not in `results` falls back
 * to its `previous` summary value rather than `down`, so a partial batch never
 * blanks untouched sites.
 */
async function writeSummary(
  env: Env,
  config: StatusConfig,
  results: CheckResult[],
  previous: Map<string, SiteSummary>,
  now: Date,
): Promise<void> {
  const historyBySlug = await readHistory(env, now)
  const summary = buildSiteSummaries({ sites: config.sites, results, previous, historyBySlug, now })
  await env.STATUS_KV.put(KV_KEYS.summary, JSON.stringify(summary))
}

/**
 * Aggregate the D1 `checks` table into one row per (slug, day) for the last
 * 90 days and hand the counts to core, which owns the per-day rollup.
 */
async function readHistory(env: Env, now: Date): Promise<Map<string, Map<string, DayStat>>> {
  const since = historyWindowStart(now)
  // Filter on the raw ISO `checked_at` (sargable via idx_checks_time) rather
  // than `date(checked_at)`, which would wrap the column and skip the index.
  const rows = await env.DB.prepare(
    `SELECT slug,
            date(checked_at) AS day,
            SUM(status = 'up') AS up,
            SUM(status = 'degraded') AS degraded,
            SUM(status = 'down') AS down,
            COUNT(*) AS total
     FROM checks
     WHERE checked_at >= ?
     GROUP BY slug, day`,
  ).bind(since.toISOString()).all<DayCounts>()
  return groupDayStats(rows.results)
}
