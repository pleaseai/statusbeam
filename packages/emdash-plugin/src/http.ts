import type { HttpAccess } from 'emdash'
import { createUnrestrictedHttpAccess } from 'emdash'

/**
 * A `fetch` that resolves as soon as the response headers arrive and drops the
 * body. The returned response keeps the status, status text and headers
 * (including `Location`, so a redirect can still be followed) but has no body.
 *
 * The host's own `ctx.http.fetch` buffers the whole body (8 MiB cap) before it
 * resolves, so a slow or large body would be timed and graded on its last
 * byte. Header-time probing is what a status check measures.
 */
export function headerOnlyFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImpl(input, init)
    // Not awaited: a hung body must not hold up the result.
    response.body?.cancel().catch(() => {})
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
  }) as typeof fetch
}

/**
 * The plugin's probe client: the host's unrestricted HTTP access wrapped around
 * {@link headerOnlyFetch}. The host keeps its DNS-aware SSRF check on every hop
 * (loopback, private, link-local and cloud-metadata targets are refused, also
 * behind a redirect) and its 5-hop redirect cap; only the body read changes.
 *
 * `createUnrestrictedHttpAccess` is exported from `emdash` but undocumented, so
 * this pins the plugin to the EmDash line it was verified on (1.3.1).
 */
export function createProbeHttp(pluginId: string, fetchImpl: typeof fetch = globalThis.fetch): HttpAccess {
  return createUnrestrictedHttpAccess(pluginId, headerOnlyFetch(fetchImpl))
}
