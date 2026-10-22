import type { APIRoute } from 'astro'
import { buildStatusResponse } from '@statusbeam/core'
import { jsonResponse } from '../../lib/api'
import { getSummary } from '../../lib/data'

// On-demand: reads the live KV snapshot at the edge, fronted by Workers Cache.
export const prerender = false

/**
 * Public status API: the whole dashboard as JSON in one read. `status` is the
 * rolled-up severity (worst site wins); `sites` is a lean per-site summary
 * (history omitted — fetch `/api/status/<slug>.json` for a single site's
 * timeline). The body shape is the core `statusResponseSchema` contract.
 */
export const GET: APIRoute = async () => {
  const summary = await getSummary()
  return jsonResponse(buildStatusResponse(summary), { tagSlugs: summary.map(s => s.slug) })
}
