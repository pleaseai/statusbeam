import type { APIRoute } from 'astro'
import { parsePeriod, uptimeBadge } from '@statusbeam/core'
import { jsonResponse, notFound } from '../../../../lib/api'
import { getSite } from '../../../../lib/data'

export const prerender = false

/**
 * Per-site uptime badge (shields.io endpoint): `uptime | 99.98%`. The window is
 * chosen with `?period=day|week|month` (default `month`).
 * `https://img.shields.io/endpoint?url=<origin>/api/badge/<slug>/uptime.json`
 */
export const GET: APIRoute = async ({ params, url }) => {
  const slug = params.slug ?? ''
  const site = await getSite(slug)
  if (!site) {
    return notFound(`No site with slug "${slug}"`)
  }
  const period = parsePeriod(url.searchParams.get('period'))
  return jsonResponse(uptimeBadge(site, period), { tagSlugs: [site.slug] })
}
