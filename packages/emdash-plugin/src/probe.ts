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
 * Run one check through the core engine with `ctx.http.fetch` injected and a
 * deadline on the fetch. A miss rejects inside `checkSite`, which grades it
 * `down` with `code: 0` exactly like a network failure. The method is never
 * rewritten: a configured GET stays a GET.
 */
export function probeSite(fetchImpl: HostFetch, site: Site, deadlineMs = PROBE_DEADLINE_MS): Promise<CheckResult> {
  return checkSite(site, {
    fetchImpl: (url, init) => withDeadline(fetchImpl(url, init), deadlineMs),
  })
}
