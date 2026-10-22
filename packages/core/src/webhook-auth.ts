import type { Site } from './config'
import type { CheckStatus } from './types'
import { deriveSentryWebhookStatus, sentryWebhookSchema } from './sentry-webhook'
import { deriveStatuspageWebhookStatus, statuspageWebhookSchema } from './statuspage-webhook'

/** Webhook providers StatusBeam accepts inbound pushes from. */
export type WebhookProvider = 'statuspage' | 'sentry'

const PROVIDERS: readonly WebhookProvider[] = ['statuspage', 'sentry']

/**
 * Match an inbound webhook route `/webhooks/:provider/:slug` and return the
 * provider + site slug, or `null` for any other path. Empty segments (leading or
 * trailing slashes) are ignored. `:provider` must be one we support
 * (`statuspage`/`sentry`), otherwise the path doesn't match.
 */
export function parseWebhookPath(pathname: string): { provider: WebhookProvider, slug: string } | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 3 && parts[0] === 'webhooks' && parts[2] && (PROVIDERS as readonly string[]).includes(parts[1]!)) {
    return { provider: parts[1] as WebhookProvider, slug: parts[2] }
  }
  return null
}

/**
 * Constant-time string equality — compares every character so the time taken
 * doesn't leak how many leading characters of the secret were correct. A length
 * mismatch short-circuits (the length itself isn't the secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Whether a site's `check` kind may receive webhooks on the given provider
 * route. incident.io status pages are Statuspage-compatible, so a
 * `check: incidentio` site is a valid `statuspage` target; any other provider
 * must match its check kind exactly.
 */
export function webhookProviderMatchesSite(
  provider: WebhookProvider,
  site: Pick<Site, 'check'> | undefined,
): boolean {
  return provider === 'statuspage'
    ? site?.check === 'statuspage' || site?.check === 'incidentio'
    : site?.check === provider
}

/**
 * Grade a provider's inbound payload for one site: parse it against the
 * provider's schema and map it to a `CheckStatus`. Returns `{ status }` on a
 * gradeable event, `{ status: null }` when the event doesn't concern this site,
 * or `{ error }` when the payload is the wrong shape. The site's `check` kind is
 * assumed to match `provider` (see {@link webhookProviderMatchesSite}).
 */
export function gradeWebhookPayload(provider: WebhookProvider, body: unknown, site: { component?: string }):
  | { status: CheckStatus | null }
  | { error: 'invalid-payload', reason: string } {
  if (provider === 'sentry') {
    const parsed = sentryWebhookSchema.safeParse(body)
    if (!parsed.success) {
      return { error: 'invalid-payload', reason: parsed.error.message }
    }
    return { status: deriveSentryWebhookStatus(parsed.data) }
  }
  const parsed = statuspageWebhookSchema.safeParse(body)
  if (!parsed.success) {
    return { error: 'invalid-payload', reason: parsed.error.message }
  }
  return { status: deriveStatuspageWebhookStatus(parsed.data, site) }
}
