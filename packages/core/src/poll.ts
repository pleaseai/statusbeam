import type { Site } from './config'

/**
 * Pick the sites a scheduled run must actively check. Skips webhook-only Sentry
 * sites (a `check: sentry` site with no `sentry:` poll block), and Sentry poll
 * sites when there is no token to authenticate with — polling either would
 * record a false `down` and clobber the webhook-driven status. A poll site with
 * no token is a deploy/config mistake, so it is skipped with a warning; a
 * webhook-only site is skipped quietly.
 */
export function selectPollSites<S extends Pick<Site, 'check' | 'slug' | 'sentry'>>(
  sites: S[],
  options: { sentryToken?: string, warn?: (message: string) => void } = {},
): S[] {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  return sites.filter((site) => {
    if (site.check !== 'sentry') {
      return true
    }
    // A whitespace-only token cannot authenticate either, so it counts as missing.
    if (site.sentry !== undefined && !options.sentryToken?.trim()) {
      warn(`scheduled: sentry poll configured for "${site.slug}" but SENTRY_AUTH_TOKEN is missing; skipping poll`)
      return false
    }
    return site.sentry !== undefined
  })
}
