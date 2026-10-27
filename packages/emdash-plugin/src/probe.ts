import type { CheckResult, Site } from '@statusbeam/core'
import { checkSite } from '@statusbeam/core'

type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Deadline for one probe or one delivery. A response that has not finished by then is `down`, without delaying the others. */
export const PROBE_DEADLINE_MS = 10_000

/**
 * Reject after `ms`. The timer is the backstop behind the `AbortSignal`: a
 * lookup or response that ignores the signal still ends at the deadline. The
 * abandoned fetch is left to settle on its own and its late outcome is swallowed.
 */
export function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe exceeded the ${ms} ms deadline`)), ms)
  })
  pending.catch(() => {})
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer))
}

/**
 * `fetchImpl` under a deadline. The request carries an `AbortSignal` that fires
 * at the deadline (combined with any signal the checker passes), so the host
 * stops waiting and releases the connection, and the caller also stops waiting.
 */
export function fetchWithDeadline(fetchImpl: ProbeFetch, ms: number): ProbeFetch {
  return (url, init) => {
    const timeout = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return withDeadline(fetchImpl(url, { ...init, signal }), ms)
  }
}

/**
 * The host's response-body cap, recognised by message text. The rejection has no
 * error code and its text is wrapped differently per mode: the bare
 * `Plugin HTTP response body exceeds the 8388608 byte limit`, or the same text
 * inside `Bridge call http/fetch failed: {...}` on Node/workerd. A substring
 * match tolerates both.
 */
const BODY_LIMIT_PATTERN = /response body exceeds the \d+ byte limit/i

/** Core's `classifyError` for this host: `'body'` for the host's body cap, otherwise `undefined`. */
export function classifyHostError(error: unknown): 'body' | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return BODY_LIMIT_PATTERN.test(message) ? 'body' : undefined
}

/**
 * Run one check through the core engine with `fetchImpl` under a deadline. A
 * miss rejects inside `checkSite`, which grades it `down` with `code: 0` exactly
 * like a network failure. A body-limit rejection comes back with
 * `limit: 'body'`: the host's cap ended the request, so the result says nothing
 * about the target. The method is never rewritten: a configured GET stays
 * a GET.
 */
export function probeSite(
  fetchImpl: ProbeFetch,
  site: Site,
  deadlineMs = PROBE_DEADLINE_MS,
  now?: () => number,
  sentryToken?: string,
): Promise<CheckResult> {
  return checkSite(site, {
    fetchImpl: fetchWithDeadline(fetchImpl, deadlineMs),
    classifyError: classifyHostError,
    ...(now ? { now } : {}),
    ...(sentryToken ? { sentryToken } : {}),
  })
}
