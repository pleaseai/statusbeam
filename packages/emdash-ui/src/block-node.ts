import type { RouteFlavor } from '@statusbeam/core/contract'
import type { StatusSource } from './client'

/**
 * The "status" Portable Text block's data shape and its mapping to the T010
 * components. This module is plain TypeScript with no EmDash import, so both
 * the editor definition (`./block`) and the renderer (`./astro`) share one
 * source of truth for the block `type` and its field ids.
 *
 * Field set (kept minimal; each field maps to a component prop):
 * - `view`: `banner` (overall status) or `site` (one site's detail).
 * - `slug`: the site to show; required when `view` is `site`.
 * - `baseUrl` + `flavor`: the producer to read, as `StatusSource` takes them.
 *
 * There is no site-level default: a Portable Text block renderer receives only
 * the block's own data, so each block carries its source.
 */
export const BLOCK_TYPE = 'statusbeam-status'

export const BLOCK_VIEWS = ['banner', 'site'] as const
export type BlockView = (typeof BLOCK_VIEWS)[number]

export const BLOCK_FLAVORS = ['standalone', 'emdash'] as const satisfies readonly RouteFlavor[]

export type BlockSelection
  = | { ok: true, view: 'banner', source: StatusSource }
    | { ok: true, view: 'site', source: StatusSource, slug: string }
    | { ok: false, reason: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Turn raw block data into a validated selection. Editor-supplied data is
 * untrusted: the base URL must be an absolute http(s) URL, anything else is
 * refused so the renderer never fetches `file:` or similar schemes.
 */
export function selectFromBlock(node: Record<string, unknown>): BlockSelection {
  const baseUrl = text(node.baseUrl)
  let url: URL
  try {
    url = new URL(baseUrl)
  }
  catch {
    return { ok: false, reason: 'baseUrl must be an absolute URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'baseUrl must use http or https' }
  }
  const flavor: RouteFlavor = node.flavor === 'emdash' ? 'emdash' : 'standalone'
  const source: StatusSource = { baseUrl, flavor }
  if (node.view !== 'site') {
    return { ok: true, view: 'banner', source }
  }
  const slug = text(node.slug)
  return slug ? { ok: true, view: 'site', source, slug } : { ok: false, reason: 'slug is required for the site view' }
}
