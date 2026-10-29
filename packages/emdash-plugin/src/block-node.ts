import type { RouteFlavor } from '@statusbeam/core/contract'
import type { FetchOptions, StatusSource } from '@statusbeam/emdash-ui/client'

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
 * There is no site-level default source: a Portable Text block renderer
 * receives only the block's own data, so each block carries its source. The
 * one site-level setting, the allowed origins, reaches the renderer through
 * `./block-config`.
 */
export const BLOCK_TYPE = 'statusbeam-status'

export const BLOCK_VIEWS = ['banner', 'site'] as const

export const BLOCK_FLAVORS = ['standalone', 'emdash'] as const satisfies readonly RouteFlavor[]

export type BlockSelection
  = | { ok: true, view: 'banner', source: StatusSource }
    | { ok: true, view: 'site', source: StatusSource, slug: string }
    | { ok: false, reason: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** IPv4 ranges a server-side fetch must not reach: `[first octets, prefix length]`. */
const PRIVATE_V4: Array<[number[], number]> = [
  [[127], 8], // loopback
  [[10], 8], // private
  [[172, 16], 12], // private
  [[192, 168], 16], // private
  [[169, 254], 16], // link-local
  [[0], 8], // unspecified ("this network")
]

function inV4Range(octets: number[], [base, bits]: [number[], number]): boolean {
  const value = (octets[0]! << 24 | octets[1]! << 16 | octets[2]! << 8 | octets[3]!) >>> 0
  const start = ((base[0] ?? 0) << 24 | (base[1] ?? 0) << 16) >>> 0
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  return ((value & mask) >>> 0) === start
}

function isPrivateV4(octets: number[]): boolean {
  return PRIVATE_V4.some(range => inV4Range(octets, range))
}

/** The eight 16-bit groups of a serialized IPv6 address (`URL` always emits the compressed hex form), or `null`. */
function v6Groups(address: string): number[] | null {
  const [head = '', tail] = address.split('::')
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16)))
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  const groups = tail === undefined ? left : [...left, ...Array.from<number>({ length: 8 - left.length - right.length }).fill(0), ...right]
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xFFFF) ? groups : null
}

/**
 * Why a URL host is not a public address, or `undefined` when it is acceptable.
 * Works on `URL.hostname`, which has already normalised IPv4 spellings
 * (`2130706433`, `0x7f.1`) to dotted decimal and IPv6 to compressed hex.
 * A hostname that resolves to a private address through DNS is not caught here.
 */
function nonPublicHost(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'baseUrl must not point at localhost'
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    return isPrivateV4(v4.slice(1).map(Number)) ? 'baseUrl must not be a loopback, private, link-local or unspecified address' : undefined
  }
  if (!host.startsWith('[')) {
    return undefined
  }
  const groups = v6Groups(host.slice(1, -1))
  if (!groups) {
    return 'baseUrl has an unreadable IPv6 address'
  }
  const [first = 0] = groups
  const zeroPrefix = groups.slice(0, 5).every(group => group === 0)
  const loopbackOrUnspecified = zeroPrefix && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)
  const linkLocal = (first & 0xFFC0) === 0xFE80
  const uniqueLocal = (first & 0xFE00) === 0xFC00
  const mapped = zeroPrefix && groups[5] === 0xFFFF
    && isPrivateV4([groups[6]! >> 8, groups[6]! & 0xFF, groups[7]! >> 8, groups[7]! & 0xFF])
  return loopbackOrUnspecified || linkLocal || uniqueLocal || mapped
    ? 'baseUrl must not be a loopback, link-local, unique-local or unspecified address'
    : undefined
}

export interface SelectOptions {
  /**
   * Accept localhost and loopback, private, link-local and unique-local IP
   * literals. Only for development, where the source runs on this machine; the
   * renderer passes it under `import.meta.env.DEV` only. Credentials, a query
   * and a fragment are refused either way.
   */
  allowPrivateHosts?: boolean
  /**
   * Administrator-approved origins (scheme, host and port) a block may fetch.
   * When non-empty, a base URL whose origin is not listed is refused, and the
   * list replaces the literal-address check: an approved origin is fetched
   * even if it names a private address, and a name that resolves to a private
   * address is stopped unless it is listed. Credentials, a query and a fragment
   * are still refused. One unreadable entry refuses every block, naming it.
   */
  allowedOrigins?: readonly string[]
}

/**
 * Fetch options for a block's server-side read. Redirects are not followed:
 * the checks in `selectFromBlock` see only the configured URL, so following a
 * redirect would let an accepted source send the server to an origin nobody
 * approved. A redirect answer renders as unavailable (`HTTP 3xx`).
 * `redirect: 'manual'` rather than `'error'`, which Cloudflare Workers reject.
 */
export function blockFetchOptions(fetchImpl: typeof fetch = fetch): FetchOptions {
  return { fetch: ((input, init) => fetchImpl(input, { ...init, redirect: 'manual' })) as typeof fetch }
}

export type OriginList
  = | { ok: true, origins: string[] }
    | { ok: false, reason: string }

/**
 * Validate configured origins and normalise each to `URL.origin` (lowercase
 * host, default port dropped). An entry must be an absolute http(s) URL with no
 * credentials, path beyond `/`, query or fragment; the first one that is not is
 * reported instead of being skipped.
 */
export function parseAllowedOrigins(entries: unknown): OriginList {
  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'allowedOrigins must be an array of origins' }
  }
  const origins: string[] = []
  for (const entry of entries) {
    const reason = `allowedOrigins entry ${JSON.stringify(entry)} must be an http(s) origin such as https://status.example.com`
    if (typeof entry !== 'string') {
      return { ok: false, reason }
    }
    let url: URL
    try {
      url = new URL(entry.trim())
    }
    catch {
      return { ok: false, reason }
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.href.includes('?') || url.href.includes('#')) {
      return { ok: false, reason }
    }
    origins.push(url.origin)
  }
  return { ok: true, origins }
}

/**
 * Turn raw block data into a validated selection. Editor-supplied data is
 * untrusted and the renderer fetches it on the server, so the base URL must be
 * an absolute http(s) URL with no credentials, query or fragment (either would
 * change what the appended contract path means), and must not name localhost or
 * a loopback, private, link-local or unique-local IP literal. Anything else is
 * refused, with the reason, unless `options.allowPrivateHosts` lifts the host check.
 * With a non-empty `options.allowedOrigins`, the origin must be listed instead.
 */
export function selectFromBlock(node: Record<string, unknown>, options: SelectOptions = {}): BlockSelection {
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
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'baseUrl must not carry credentials' }
  }
  // `href`, not `search`/`hash`: an empty `?` or `#` reads as '' there but still swallows the appended path.
  if (url.href.includes('?') || url.href.includes('#')) {
    return { ok: false, reason: 'baseUrl must not carry a query string or a fragment' }
  }
  // Options can arrive unvalidated (`createPlugin` called directly), so any defined value is
  // parsed: a malformed one refuses the block instead of silently restoring the literal check.
  let origins: string[] = []
  if (options.allowedOrigins !== undefined) {
    const allowed = parseAllowedOrigins(options.allowedOrigins)
    if (!allowed.ok) {
      return { ok: false, reason: allowed.reason }
    }
    origins = allowed.origins
  }
  if (origins.length > 0) {
    if (!origins.includes(url.origin)) {
      return { ok: false, reason: `baseUrl origin ${url.origin} is not in the site's allowed origins` }
    }
  }
  else {
    const hostReason = options.allowPrivateHosts ? undefined : nonPublicHost(url.hostname)
    if (hostReason) {
      return { ok: false, reason: hostReason }
    }
  }
  const flavor: RouteFlavor = node.flavor === 'emdash' ? 'emdash' : 'standalone'
  const source: StatusSource = { baseUrl, flavor }
  if (node.view !== 'site') {
    return { ok: true, view: 'banner', source }
  }
  const slug = text(node.slug)
  return slug ? { ok: true, view: 'site', source, slug } : { ok: false, reason: 'slug is required for the site view' }
}
