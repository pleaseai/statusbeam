import type { RouteFlavor, SiteResponse, StatusResponse } from '@statusbeam/core/contract'
import { routePaths, siteResponseSchema, statusResponseSchema } from '@statusbeam/core/contract'

/**
 * Contract client for the StatusBeam public JSON. It reads the same contract
 * from either producer: a standalone StatusBeam deployment (`/api/*`) or the
 * EmDash plugin's routes. Only the base URL and flavor differ.
 *
 * Every function here resolves; none throws. A network error, a non-2xx
 * response, or a body that fails the contract schema yields an `unavailable`
 * result, so a page that embeds status keeps rendering when the source is down.
 *
 * Imports come only from `@statusbeam/core/contract` (never the core root), so
 * the render library pulls in no config parsing, check engine or `yaml`.
 */

/** Where to read status from. */
export interface StatusSource {
  /** Origin (optionally with a path prefix) of the producer, e.g. `https://status.example.com`. */
  baseUrl: string
  /** Which producer serves `baseUrl`. Defaults to `standalone`. */
  flavor?: RouteFlavor
}

/** Why a read failed. */
export type UnavailableReason = 'network' | 'http' | 'contract'

export interface Unavailable {
  ok: false
  reason: UnavailableReason
  /** Human-readable detail for logs; never shown as the visible status. */
  detail: string
  url: string
}

export interface Available<T> {
  ok: true
  data: T
  url: string
}

export type StatusResult<T> = Available<T> | Unavailable

export interface FetchOptions {
  /** Fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Abort signal, e.g. `AbortSignal.timeout(5000)`. An abort yields `unavailable`. */
  signal?: AbortSignal
}

/** Join a base URL and a contract path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/** URL of the aggregate status response for a source. */
export function statusUrl(source: StatusSource): string {
  return joinUrl(source.baseUrl, routePaths[source.flavor ?? 'standalone'].status())
}

/** URL of the per-site response for a source. */
export function siteUrl(source: StatusSource, slug: string): string {
  return joinUrl(source.baseUrl, routePaths[source.flavor ?? 'standalone'].site(slug))
}

function unavailable(url: string, reason: UnavailableReason, detail: string): Unavailable {
  return { ok: false, reason, detail, url }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The slice of a zod schema this client uses (keeps `zod` out of our own dependencies). */
interface Schema<T> {
  safeParse: (value: unknown) => { success: true, data: T } | { success: false, error: { message: string } }
}

async function fetchContract<T>(url: string, schema: Schema<T>, options: FetchOptions): Promise<StatusResult<T>> {
  const fetchImpl = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: options.signal })
  }
  catch (error) {
    return unavailable(url, 'network', message(error))
  }
  if (!response.ok) {
    return unavailable(url, 'http', `HTTP ${response.status}`)
  }
  let body: unknown
  try {
    body = await response.json()
  }
  catch (error) {
    return unavailable(url, 'contract', `invalid JSON: ${message(error)}`)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return unavailable(url, 'contract', parsed.error.message)
  }
  return { ok: true, data: parsed.data, url }
}

/** Read the aggregate status (overall severity plus one row per site). */
export function fetchStatus(source: StatusSource, options: FetchOptions = {}): Promise<StatusResult<StatusResponse>> {
  return fetchContract(statusUrl(source), statusResponseSchema, options)
}

/** Read one site's full detail, including its 90-day history. */
export function fetchSite(source: StatusSource, slug: string, options: FetchOptions = {}): Promise<StatusResult<SiteResponse>> {
  return fetchContract(siteUrl(source, slug), siteResponseSchema, options)
}

/**
 * Component input: either a source to fetch from, or a result the page already
 * fetched (so several components can share one request).
 */
export type StatusInput = { result: StatusResult<StatusResponse> } | StatusSource
export type SiteInput = { result: StatusResult<SiteResponse> } | (StatusSource & { slug: string })

/** Resolve a component's aggregate-status input to a result. */
export function loadStatus(input: StatusInput, options: FetchOptions = {}): Promise<StatusResult<StatusResponse>> {
  return 'result' in input ? Promise.resolve(input.result) : fetchStatus(input, options)
}

/** Resolve a component's per-site input to a result. */
export function loadSite(input: SiteInput, options: FetchOptions = {}): Promise<StatusResult<SiteResponse>> {
  return 'result' in input ? Promise.resolve(input.result) : fetchSite(input, input.slug, options)
}
