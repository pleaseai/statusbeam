/**
 * The plain settings key that holds the monitor configuration as YAML. Every
 * reader validates it with the plugin rules (`config.ts`) before using it.
 */
export const CONFIG_SETTINGS_KEY = 'config'

/** Encrypted secret setting: the Slack incoming-webhook URL. */
export const SLACK_SECRET_KEY = 'slackWebhookUrl'

/** Encrypted secret setting: generic webhook URLs, one per line (commas and spaces also separate). */
export const WEBHOOKS_SECRET_KEY = 'webhookUrls'

/** Encrypted secret setting: the shared token inbound webhooks must carry in `?token=`. Unset means every webhook is rejected. */
export const WEBHOOK_SECRET_KEY = 'webhookSecret'

/** Encrypted secret setting: the Sentry API token used to poll Sentry monitors (separate from the webhook secret). */
export const SENTRY_TOKEN_SECRET_KEY = 'sentryToken'

/** One notification destination. The URL is a secret: never persist or log it. */
export interface Destination {
  kind: 'slack' | 'webhook'
  url: string
}

/** Whether `entry` is an http(s) URL, the only kind a destination can be. */
export function isHttpUrl(entry: string): boolean {
  return URL.canParse(entry) && ['https:', 'http:'].includes(new URL(entry).protocol)
}

/**
 * Split a secret holding URLs into valid http(s) URLs and a count of the rest.
 * The count carries no text, so a malformed secret cannot leak through it.
 */
export function parseUrlList(value: unknown): { urls: string[], invalid: number } {
  if (typeof value !== 'string') {
    return { urls: [], invalid: 0 }
  }
  const urls: string[] = []
  let invalid = 0
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    if (isHttpUrl(entry)) {
      urls.push(entry)
    }
    else {
      invalid += 1
    }
  }
  return { urls, invalid }
}

/**
 * Destinations held in the secret settings. A repeated URL is one destination,
 * across both settings too: a URL set as the Slack webhook and listed in the
 * webhook URLs is posted to once, as Slack. Only the first Slack URL is used.
 */
export function destinationsFrom(values: Map<string, unknown>): { destinations: Destination[], invalid: number } {
  const slack = parseUrlList(values.get(SLACK_SECRET_KEY))
  const webhooks = parseUrlList(values.get(WEBHOOKS_SECRET_KEY))
  const slackUrls = slack.urls.slice(0, 1)
  const destinations: Destination[] = [
    ...slackUrls.map(url => ({ kind: 'slack' as const, url })),
    ...[...new Set(webhooks.urls)].filter(url => !slackUrls.includes(url)).map(url => ({ kind: 'webhook' as const, url })),
  ]
  return { destinations, invalid: slack.invalid + webhooks.invalid + Math.max(0, slack.urls.length - 1) }
}
