import type { ConfigResponse, OverviewResponse, SaveResponse } from '../routes/admin'
import { apiFetch, parseApiResponse } from '@emdash-cms/admin'
import { EMDASH_ROUTE_BASE } from '@statusbeam/core'
import { ADMIN_ROUTE } from '../admin-routes'

/**
 * The client of the plugin's private admin routes (`src/routes/admin.ts`).
 *
 * `apiFetch` adds the `X-EmDash-Request` header the host's CSRF check needs on
 * every cookie request, GET included. `parseApiResponse` unwraps the host
 * envelope `{ success: true, data }` and turns an error envelope into an
 * `ApiResponseError`. The server module is imported for types only, so none of
 * its code reaches the browser bundle.
 */

const BASE = EMDASH_ROUTE_BASE
const ROUTE = ADMIN_ROUTE

/** Where EmDash's generated settings page for the plugin lives (secrets are edited there). */
export const SETTINGS_PAGE_HREF = '/_emdash/admin/plugins-manager/statusbeam/settings'

/** Where the plugin's admin pages live: the status overview, and the monitor editor beside it. */
export const OVERVIEW_PAGE_HREF = '/_emdash/admin/plugins/statusbeam/'
export const MONITORS_PAGE_HREF = '/_emdash/admin/plugins/statusbeam/monitors'

/** `GET` a route and return its `data`. */
export async function getAdmin<T>(route: keyof typeof ROUTE, failed: string): Promise<T> {
  return parseApiResponse<T>(await apiFetch(`${BASE}/${ROUTE[route]}`), failed)
}

/** `POST` a JSON body to a route and return its `data`. */
export async function postAdmin<T>(route: keyof typeof ROUTE, body: unknown, failed: string): Promise<T> {
  const response = await apiFetch(`${BASE}/${ROUTE[route]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseApiResponse<T>(response, failed)
}

export function loadConfig(failed: string): Promise<ConfigResponse> {
  return getAdmin<ConfigResponse>('config', failed)
}

export function saveConfig(config: Record<string, unknown>, revision: string | null, failed: string): Promise<SaveResponse> {
  return postAdmin<SaveResponse>('save', { config, revision }, failed)
}

export function loadOverview(failed: string): Promise<OverviewResponse> {
  return getAdmin<OverviewResponse>('overview', failed)
}
