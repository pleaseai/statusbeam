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

/**
 * Deadline in ms on one read, covering both the request and the body. A source
 * that accepts the connection and then stalls would otherwise hold the page
 * render open.
 */
export const DEFAULT_TIMEOUT_MS = 10_000

export interface FetchOptions {
  /** Fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Abort signal, e.g. to cancel with the page request. An abort yields `unavailable`. */
  signal?: AbortSignal
  /** Deadline in ms on the request and the body read together; defaults to {@link DEFAULT_TIMEOUT_MS}. A miss yields `unavailable`. */
  timeoutMs?: number
}

/** Join a base URL and a contract path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  // A linear scan rather than `/\/+$/`, which backtracks polynomially on many trailing slashes.
  let end = baseUrl.length
  while (end > 0 && baseUrl.endsWith('/', end)) {
    end--
  }
  return `${baseUrl.slice(0, end)}${path}`
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

/**
 * A signal that aborts when any of `signals` does: `AbortSignal.any` where the
 * runtime has it, otherwise wired by hand. Call `dispose` once the request
 * settles so a long-lived caller signal does not keep the hand-wired listeners.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal, dispose: () => void } {
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(signals), dispose: () => {} }
  }
  const controller = new AbortController()
  const listeners: Array<[AbortSignal, () => void]> = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push([signal, onAbort])
  }
  return {
    signal: controller.signal,
    dispose: () => listeners.forEach(([signal, onAbort]) => signal.removeEventListener('abort', onAbort)),
  }
}

/**
 * Settle with `pending`, or reject as soon as `signal` aborts. The fetch is
 * handed the signal too, but an implementation that ignores it, or a body
 * stream that never ends, must not outlive the deadline.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    pending.catch(() => {})
    return Promise.reject(signal.reason)
  }
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  pending.catch(() => {})
  return Promise.race([pending, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

async function fetchContract<T>(url: string, schema: Schema<T>, options: FetchOptions): Promise<StatusResult<T>> {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(`read exceeded the ${timeoutMs} ms deadline`)), timeoutMs)
  const { signal, dispose } = options.signal
    ? anySignal([options.signal, deadline.signal])
    : { signal: deadline.signal, dispose: () => {} }
  try {
    let response: Response
    try {
      response = await untilAborted(fetchImpl(url, { headers: { accept: 'application/json' }, signal }), signal)
    }
    catch (error) {
      return unavailable(url, 'network', message(error))
    }
    if (!response.ok) {
      return unavailable(url, 'http', `HTTP ${response.status}`)
    }
    let body: unknown
    try {
      body = await untilAborted(response.json(), signal)
    }
    catch (error) {
      // A deadline or a cancellation during the body read is a transport failure, not a bad body.
      return signal.aborted
        ? unavailable(url, 'network', message(signal.reason))
        : unavailable(url, 'contract', `invalid JSON: ${message(error)}`)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return unavailable(url, 'contract', parsed.error.message)
    }
    return { ok: true, data: parsed.data, url }
  }
  finally {
    clearTimeout(timer)
    dispose()
  }
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
