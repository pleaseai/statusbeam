import type { SiteSummary } from '@statusbeam/core'
import type { PluginContext, RouteEntry } from 'emdash/plugin'
import { buildSiteResponse, buildStatusResponse, overallBadge, parsePeriod, responseBadge, statusBadge, uptimeBadge } from '@statusbeam/core'
import { pluginResponse, pluginRoute } from 'emdash/plugin'
import { readSettings } from '../settings'
import { readSnapshot, summariesFromSnapshot } from '../snapshot'

/**
 * Same policy as the standalone `/api/*` endpoints (`apps/web/src/lib/api.ts`).
 * The host applies it to successful public GETs only; an error response stays
 * `private, no-store`, which is also what standalone's 404 sets.
 */
export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=600'

type ReadContext = Pick<PluginContext, 'settings' | 'kv'>
type Query = Record<string, unknown>

function json(data: unknown, status = 200) {
  return pluginResponse({
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: { kind: 'text', value: JSON.stringify(data) },
  })
}

/** The standalone 404 body for an unknown site slug. */
function notFound(slug: string) {
  return json({ error: `No site with slug "${slug}"` }, 404)
}

/**
 * Serialize the plugin's state the way the standalone data layer's `getSummary`
 * feeds its endpoints. At most two bridge calls (the settings list, one
 * snapshot prefix list) and none per monitor. An absent or invalid
 * configuration has no monitors, so the endpoints answer as standalone does for
 * an empty summary.
 */
async function loadSummary(ctx: ReadContext): Promise<SiteSummary[]> {
  const { config } = await readSettings(ctx)
  if (!config) {
    return []
  }
  return summariesFromSnapshot(await readSnapshot(ctx), config.sites, new Date())
}

function queryOf(input: unknown): Query {
  return typeof input === 'object' && input !== null ? input as Query : {}
}

function stringParam(query: Query, name: string): string | null {
  const value = query[name]
  return typeof value === 'string' ? value : null
}

interface Handlers {
  /** Answers when the request carries no `slug`; omit it for a route that always needs one. */
  aggregate?: (summary: SiteSummary[]) => unknown
  /** Answers for one site, given the query. */
  site: (site: SiteSummary, query: Query) => unknown
}

/** A public, raw, GET-only route with the standalone cache policy. */
function publicRoute({ aggregate, site: build }: Handlers): RouteEntry {
  return pluginRoute({
    public: true,
    response: 'raw',
    methods: ['GET'],
    cacheControl: PUBLIC_CACHE_CONTROL,
    request: { body: 'none' },
    handler: async (routeCtx, ctx) => {
      const query = queryOf(routeCtx.input)
      const summary = await loadSummary(ctx)
      if (aggregate && !('slug' in query)) {
        return json(aggregate(summary))
      }
      const slug = stringParam(query, 'slug') ?? ''
      const site = summary.find(s => s.slug === slug)
      return site ? json(build(site, query)) : notFound(slug)
    },
  }) as RouteEntry
}

/**
 * The public routes, mounted by the host under `/_emdash/api/plugins/statusbeam/`
 * (`routePaths.emdash` in core). The slug and the period are query parameters.
 */
export const publicRoutes: Record<string, RouteEntry> = {
  'status': publicRoute({ aggregate: buildStatusResponse, site: buildSiteResponse }),
  'badge': publicRoute({ aggregate: overallBadge, site: statusBadge }),
  'badge-uptime': publicRoute({ site: (site, query) => uptimeBadge(site, parsePeriod(stringParam(query, 'period'))) }),
  'badge-response-time': publicRoute({ site: responseBadge }),
}
