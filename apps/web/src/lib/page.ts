import type { Incident, SiteSummary } from '@statusbeam/core'
import type { AstroGlobal } from 'astro'
import { cacheTagHeader, overallSiteSeverity } from '@statusbeam/core'
import { getIncidents, getSummary } from './data'

export interface StatusPageData {
  summary: SiteSummary[]
  incidents: Incident[]
  overall: ReturnType<typeof overallSiteSeverity>
}

/**
 * Load the dashboard snapshot and set the page's cache headers. Called from each
 * localized page's frontmatter (not from the shared component) because Astro
 * only honors `Astro.response.headers` set at the page level, before streaming.
 */
export async function loadStatusPage(astro: AstroGlobal): Promise<StatusPageData> {
  // Independent KV reads — fetch in parallel so a cache miss waits one round
  // trip, not two in series.
  const [summary, incidents] = await Promise.all([getSummary(), getIncidents()])

  // Render at the edge, cache the result, and let Workers Cache serve subsequent
  // hits. Each locale is a distinct URL, so caches never collide across languages.
  astro.response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
  // Tag the cached response so the Worker's purge-by-tag (status-page + each
  // site) invalidates it the instant a status changes, not on TTL expiry.
  astro.response.headers.set('Cache-Tag', cacheTagHeader(summary.map(s => s.slug)))

  // Sites not checked yet are left out of the overall severity, as in `/api/status.json`.
  return { summary, incidents, overall: overallSiteSeverity(summary) }
}
