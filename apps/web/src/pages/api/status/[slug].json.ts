import type { APIRoute } from 'astro'
import { buildSiteResponse } from '@statusbeam/core'
import { jsonResponse, notFound } from '../../../lib/api'
import { getSite } from '../../../lib/data'

export const prerender = false

/**
 * Public status API for a single site: the full `SiteSummary`, including the
 * 90-day history and (when present) the response-time samples.
 */
export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug ?? ''
  const site = await getSite(slug)
  if (!site) {
    return notFound(`No site with slug "${slug}"`)
  }
  return jsonResponse(buildSiteResponse(site), { tagSlugs: [site.slug] })
}
