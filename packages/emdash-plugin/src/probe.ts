import type { CheckResult, Site } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import { checkSite } from '@statusbeam/core'
import { PROBE_DEADLINE_MS } from './budget'

type HostFetch = NonNullable<PluginContext['http']>['fetch']

/**
 * Reject after `ms`. The bridge takes no `AbortSignal`, so a plugin-side timer is
 * the only way to stop waiting on a response that never completes; the abandoned
 * fetch is left to the host, and its late outcome is swallowed.
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
 * The host's response-body cap, recognised by message text. The rejection has no
 * error code and the text differs in wrapping per mode (spike, 2026-10-22):
 * `Plugin HTTP response body exceeds the 8388608 byte limit` on Worker Loader and
 * in-process, the same text inside `Bridge call http/fetch failed: {...}` on
 * Node/workerd. A substring match tolerates both.
 */
const BODY_LIMIT_PATTERN = /response body exceeds the \d+ byte limit/i

/** Core's `classifyError` for this host: `'body'` for the host's body cap, otherwise `undefined`. */
export function classifyHostError(error: unknown): 'body' | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return BODY_LIMIT_PATTERN.test(message) ? 'body' : undefined
}

/**
 * Run one check through the core engine with `ctx.http.fetch` injected and a
 * deadline on the fetch. A miss rejects inside `checkSite`, which grades it
 * `down` with `code: 0` exactly like a network failure. A body-limit rejection
 * comes back with `limit: 'body'`: the host's cap ended the request, so the
 * result says nothing about the target. The method is never rewritten: a
 * configured GET stays a GET, and nothing retries a limit failure.
 */
export function probeSite(
  fetchImpl: HostFetch,
  site: Site,
  deadlineMs = PROBE_DEADLINE_MS,
  now?: () => number,
): Promise<CheckResult> {
  return checkSite(site, {
    fetchImpl: (url, init) => withDeadline(fetchImpl(url, init), deadlineMs),
    classifyError: classifyHostError,
    ...(now ? { now } : {}),
  })
}
