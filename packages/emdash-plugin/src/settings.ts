import type { StatusConfig } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import { validateConfig } from '@statusbeam/core'

/**
 * The plain settings key that holds the monitor configuration as YAML.
 *
 * Seam for T008: it adds plugin-only validation and the admin error state, and
 * gates each run on them. Until then the scheduled run only needs "a valid
 * configuration, or nothing".
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

export interface PluginSettings {
  /** The validated configuration, or `null` when it is absent or invalid. */
  config: StatusConfig | null
  /** Notification destinations from the secret settings. */
  destinations: Destination[]
  /** Secret entries that are not http(s) URLs. They are not delivered to; T008 reports them. */
  invalidDestinations: number
  /** The shared webhook token, or `null` when unset (the webhook routes then reject everything). */
  webhookSecret: string | null
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

/** Destinations held in the secret settings; a repeated URL is one destination. */
export function destinationsFrom(values: Map<string, unknown>): { destinations: Destination[], invalid: number } {
  const slack = parseUrlList(values.get(SLACK_SECRET_KEY))
  const webhooks = parseUrlList(values.get(WEBHOOKS_SECRET_KEY))
  const destinations: Destination[] = [
    ...slack.urls.slice(0, 1).map(url => ({ kind: 'slack' as const, url })),
    ...[...new Set(webhooks.urls)].map(url => ({ kind: 'webhook' as const, url })),
  ]
  return { destinations, invalid: slack.invalid + webhooks.invalid + Math.max(0, slack.urls.length - 1) }
}

function configFrom(yaml: unknown): StatusConfig | null {
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    return null
  }
  const validation = validateConfig(yaml)
  return validation.ok ? validation.config : null
}

/**
 * Read the configuration and the notification secrets with one `settings.list`
 * call (the bridge decrypts secret fields there). An absent or invalid
 * configuration gives `config: null`: callers then check nothing and write
 * nothing, so no monitor's status changes.
 */
export async function readSettings(ctx: Pick<PluginContext, 'settings'>): Promise<PluginSettings> {
  const entries = await ctx.settings.list()
  const values = new Map(entries.map(entry => [entry.key, entry.value]))
  const { destinations, invalid } = destinationsFrom(values)
  const secret = values.get(WEBHOOK_SECRET_KEY)
  return {
    config: configFrom(values.get(CONFIG_SETTINGS_KEY)),
    destinations,
    invalidDestinations: invalid,
    webhookSecret: typeof secret === 'string' && secret !== '' ? secret : null,
  }
}
