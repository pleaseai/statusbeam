import type { StatusConfig } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import type { Destination } from './settings'
import { validateConfig } from '@statusbeam/core'
import { CONFIG_SETTINGS_KEY, destinationsFrom, isHttpUrl, parseUrlList, SENTRY_TOKEN_SECRET_KEY, SLACK_SECRET_KEY, WEBHOOK_SECRET_KEY, WEBHOOKS_SECRET_KEY } from './settings'

export { SENTRY_TOKEN_SECRET_KEY } from './settings'

/** One finding about a configuration, for the admin page. `path` points at the offending field. */
export interface PluginIssue {
  severity: 'error' | 'warning'
  /** Path of the offending field, e.g. `sites[2].slug` or `notifications.slack`; a settings field name for a secret. Empty for a document-level problem. */
  path: string
  /** Written for the administrator. Never quotes a secret. */
  message: string
}

export interface PluginValidation {
  /** False iff any issue is an error. Decide on this, not on `config`. */
  ok: boolean
  /** The core-validated configuration, present iff `ok`. */
  config?: StatusConfig
  issues: PluginIssue[]
}

/** What the plugin-only rules need from the encrypted settings. */
export interface SecretsView {
  /** Notification destinations the secret settings configure. */
  destinations: number
  /** Whether a Sentry token is set. */
  sentryToken: boolean
  /** Entries of the secret URL settings that are not http(s) URLs: the field and the 1-based line, never the text. */
  invalidEntries: Array<{ field: string, line: number }>
  /** Valid URLs in the Slack setting after the first, which receive nothing: the setting takes one URL. */
  extraSlackUrls: number
}

function invalidEntriesOf(field: string, value: unknown): SecretsView['invalidEntries'] {
  if (typeof value !== 'string') {
    return []
  }
  return value.split(/\r?\n/).flatMap((text, index) =>
    text.split(/[\s,]+/).filter(Boolean).some(entry => !isHttpUrl(entry)) ? [{ field, line: index + 1 }] : [])
}

/** The secrets view of a `settings.list` result. */
export function secretsFrom(values: Map<string, unknown>): { secrets: SecretsView, destinations: Destination[] } {
  const { destinations } = destinationsFrom(values)
  const token = values.get(SENTRY_TOKEN_SECRET_KEY)
  return {
    destinations,
    secrets: {
      destinations: destinations.length,
      sentryToken: typeof token === 'string' && token.trim() !== '',
      extraSlackUrls: Math.max(0, parseUrlList(values.get(SLACK_SECRET_KEY)).urls.length - 1),
      invalidEntries: [
        ...invalidEntriesOf(SLACK_SECRET_KEY, values.get(SLACK_SECRET_KEY)),
        ...invalidEntriesOf(WEBHOOKS_SECRET_KEY, values.get(WEBHOOKS_SECRET_KEY)),
      ],
    },
  }
}

const NOT_YAML = 'Notification URLs belong in the encrypted plugin settings, not in the YAML'

function secretIssues(secrets: SecretsView): PluginIssue[] {
  const issues: PluginIssue[] = secrets.invalidEntries.map(({ field, line }) => ({
    severity: 'warning',
    path: field,
    message: `Line ${line} of the ${field} setting holds an entry that is not an http(s) URL. It receives no notifications.`,
  }))
  if (secrets.extraSlackUrls > 0) {
    issues.push({
      severity: 'warning',
      path: SLACK_SECRET_KEY,
      message: `The ${SLACK_SECRET_KEY} setting holds ${secrets.extraSlackUrls + 1} URLs, but only the first receives notifications. Move the others to the "${WEBHOOKS_SECRET_KEY}" setting or remove them.`,
    })
  }
  return issues
}

interface Analysis {
  /** Set whenever the core schema accepted the document, even when a plugin rule then failed it. */
  parsed?: StatusConfig
  issues: PluginIssue[]
}

function analyze(yaml: string, secrets: SecretsView): Analysis {
  const core = validateConfig(yaml)
  if (!core.ok) {
    return {
      issues: [
        ...core.issues.map(issue => ({
          severity: 'error' as const,
          path: issue.path,
          message: issue.line === undefined ? issue.message : `${issue.message} (line ${issue.line}, column ${issue.column})`,
        })),
        ...secretIssues(secrets),
      ],
    }
  }
  const config = core.config
  const issues: PluginIssue[] = []
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message })
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message })

  if (config.notifications?.delivery === 'queue') {
    error('notifications.delivery', 'delivery: queue needs a Cloudflare Queue, which this plugin does not support. Remove it: notifications are posted directly.')
  }
  if (config.notifications?.slack) {
    error('notifications.slack', `${NOT_YAML}. Remove this block and set the Slack webhook URL in the "${SLACK_SECRET_KEY}" setting.`)
  }
  config.notifications?.webhooks?.forEach((_, index) => {
    error(`notifications.webhooks[${index}]`, `${NOT_YAML}. Remove this entry and add the URL to the "${WEBHOOKS_SECRET_KEY}" setting, one per line.`)
  })

  const firstSeen = new Map<string, number>()
  config.sites.forEach((site, index) => {
    const first = firstSeen.get(site.slug)
    if (first === undefined) {
      firstSeen.set(site.slug, index)
    }
    else {
      error(`sites[${index}].slug`, `The slug "${site.slug}" is already used by sites[${first}]. Slugs must be unique: they key the history. Set a different slug.`)
    }
    if (site.check === 'tcp' || site.check === 'ssl') {
      warn(`sites[${index}].check`, `The plugin checks check: ${site.check} monitors over HTTP, not as a ${site.check.toUpperCase()} probe.`)
    }
    if (site.check === 'sentry' && site.sentry !== undefined && !secrets.sentryToken) {
      warn(`sites[${index}].sentry`, `This monitor polls Sentry, but no token is set in the "${SENTRY_TOKEN_SECRET_KEY}" setting. The poll backstop cannot run; webhooks still work.`)
    }
  })

  issues.push(...secretIssues(secrets))
  return { parsed: config, issues }
}

/**
 * Validate a configuration document the way the plugin runs it: the core schema
 * first (its issues keep their paths), then the plugin-only rules that stay out
 * of core. Pure. `ok` is false iff any issue is an error; warnings do not stop a save.
 */
export function validatePluginConfig(yaml: string, secrets: SecretsView): PluginValidation {
  const { parsed, issues } = analyze(yaml, secrets)
  const ok = !issues.some(issue => issue.severity === 'error')
  return { ok, ...(ok && parsed ? { config: parsed } : {}), issues }
}

/** Key of the persistent configuration error. It sits under the snapshot prefix so a run learns of it from the snapshot list it already reads. */
export const CONFIG_ERROR_KEY = 'snapshot:config-error'

/** What a run records when the stored configuration fails validation. */
export interface ConfigErrorRecord {
  version: 1
  /** ISO time of the latest run or reconcile that found the configuration invalid. */
  recordedAt: string
  /** The errors only. */
  issues: PluginIssue[]
}

/** The recorded configuration error, or `null`. */
export async function readConfigError(ctx: Pick<PluginContext, 'kv'>): Promise<ConfigErrorRecord | null> {
  return ctx.kv.get<ConfigErrorRecord>(CONFIG_ERROR_KEY)
}

/** Record the failure. It stays until {@link clearConfigError}. */
export async function recordConfigError(ctx: Pick<PluginContext, 'kv'>, issues: PluginIssue[], now: Date): Promise<void> {
  const record: ConfigErrorRecord = { version: 1, recordedAt: now.toISOString(), issues: issues.filter(issue => issue.severity === 'error') }
  await ctx.kv.set(CONFIG_ERROR_KEY, record)
}

/** Drop the recorded error. */
export async function clearConfigError(ctx: Pick<PluginContext, 'kv'>): Promise<void> {
  await ctx.kv.delete(CONFIG_ERROR_KEY)
}

/** The stored configuration as a run sees it. */
export type StoredConfig
  = | { status: 'absent' }
    | { status: 'invalid', issues: PluginIssue[] }
    | { status: 'valid', config: StatusConfig, destinations: Destination[], issues: PluginIssue[], sentryToken?: string }

/**
 * Read and re-validate the stored configuration with one `settings.list` call
 * (FR-20). An empty setting is `absent`: nothing is configured, so nothing is
 * wrong.
 */
export async function loadStoredConfig(ctx: Pick<PluginContext, 'settings'>): Promise<StoredConfig> {
  return storedConfigFrom(new Map((await ctx.settings.list()).map(entry => [entry.key, entry.value])))
}

/** {@link loadStoredConfig} over a `settings.list` result the caller already holds. Pure. */
function storedConfigFrom(values: Map<string, unknown>): StoredConfig {
  const yaml = values.get(CONFIG_SETTINGS_KEY)
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    return { status: 'absent' }
  }
  const { destinations, secrets } = secretsFrom(values)
  const { parsed, issues } = analyze(yaml, secrets)
  if (issues.some(issue => issue.severity === 'error') || !parsed) {
    return { status: 'invalid', issues }
  }
  const token = values.get(SENTRY_TOKEN_SECRET_KEY)
  const sentryToken = typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined
  return { status: 'valid', config: parsed, destinations, issues, ...(sentryToken ? { sentryToken } : {}) }
}

export interface PluginSettings {
  /** The configuration a run would use, or `null` when it is absent or fails validation (see {@link loadStoredConfig}). */
  config: StatusConfig | null
  /** Notification destinations from the secret settings. */
  destinations: Destination[]
  /** Secret entries that are not http(s) URLs. They are not delivered to; the admin page reports them. */
  invalidDestinations: number
  /** The shared webhook token, or `null` when unset (the webhook routes then reject everything). */
  webhookSecret: string | null
}

/**
 * Read the configuration and the notification secrets with one `settings.list`
 * call (the bridge decrypts secret fields there). The configuration is gated
 * exactly as the scheduled run gates it: core schema plus the plugin rules, so
 * the public and webhook routes never serve or route a configuration the run
 * refuses. An absent or rejected configuration gives `config: null`: callers
 * then check nothing and write nothing, so no monitor's status changes.
 */
export async function readSettings(ctx: Pick<PluginContext, 'settings'>): Promise<PluginSettings> {
  const entries = await ctx.settings.list()
  const values = new Map(entries.map(entry => [entry.key, entry.value]))
  const { destinations, invalid } = destinationsFrom(values)
  const stored = storedConfigFrom(values)
  const secret = values.get(WEBHOOK_SECRET_KEY)
  const trimmedSecret = typeof secret === 'string' ? secret.trim() : ''
  return {
    config: stored.status === 'valid' ? stored.config : null,
    destinations,
    invalidDestinations: invalid,
    webhookSecret: trimmedSecret !== '' ? trimmedSecret : null,
  }
}
