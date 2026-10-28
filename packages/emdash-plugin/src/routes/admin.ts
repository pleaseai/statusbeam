import type { CheckResult, Site, SiteSummary, StatusResponse } from '@statusbeam/core'
import type { HttpAccess, PluginContext, PluginRoute } from 'emdash'
import type { PluginIssue } from '../config'
import type { ScheduleReconcile } from '../schedule'
import { buildStatusResponse } from '@statusbeam/core'
import { definePluginRoute } from 'emdash'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { clearConfigError, loadStoredConfig, secretsFrom, validatePluginConfig } from '../config'
import { PLUGIN_ID } from '../descriptor'
import { createProbeHttp } from '../http'
import { PROBE_DEADLINE_MS, probeSite } from '../probe'
import { BODY_CHECKS } from '../run'
import { reconcileSchedule } from '../schedule'
import { CONFIG_SETTINGS_KEY, SENTRY_TOKEN_SECRET_KEY, SLACK_SECRET_KEY, WEBHOOK_SECRET_KEY, WEBHOOKS_SECRET_KEY } from '../settings'
import { readSnapshot, summariesFromSnapshot } from '../snapshot'

/**
 * The private routes the React admin pages call (FR-7, FR-9, FR-10).
 *
 * Every route is private: the host refuses an anonymous caller (401), a caller
 * without `plugins:manage` (403, Administrator only) and a cookie-authenticated
 * request without `X-EmDash-Request: 1` (403 CSRF) before the handler runs. The
 * handlers therefore hold no role check of their own.
 *
 * The routes speak the parsed configuration object. The server serializes it to
 * the YAML text stored under the `config` setting, validates that text with the
 * core schema plus the plugin rules, and writes it with the revision it was
 * read at. Secrets stay in the encrypted settings: a response says only which
 * of them are set.
 */

/** Route names, mounted under `/_emdash/api/plugins/statusbeam/`. */
export const ADMIN_ROUTE = {
  config: 'admin/config',
  validate: 'admin/validate',
  save: 'admin/save',
  test: 'admin/test',
  overview: 'admin/overview',
} as const

/** Largest configuration the editor accepts: the serialized YAML, in bytes. */
export const MAX_YAML_BYTES = 64 * 1024

/** Largest request body the host reads for a POST: the JSON form of a configuration is larger than its YAML. */
const MAX_REQUEST_BYTES = 4 * MAX_YAML_BYTES

/** The encrypted settings, and whether each holds a value. A value is never sent. */
export interface SecretsSet {
  [SLACK_SECRET_KEY]: boolean
  [WEBHOOKS_SECRET_KEY]: boolean
  [WEBHOOK_SECRET_KEY]: boolean
  [SENTRY_TOKEN_SECRET_KEY]: boolean
}

/** A configuration document as the editor holds it: the parsed YAML, before defaults are applied. */
export type ConfigDocument = Record<string, unknown>

/** `GET admin/config`. */
export interface ConfigResponse {
  /** The stored configuration, or `null` when none is stored or its YAML does not parse. */
  config: ConfigDocument | null
  /** Send this back on save. `null` while nothing is stored. */
  revision: string | null
  secretsSet: SecretsSet
  /** Findings about the stored configuration (errors and warnings). Empty when none is stored. */
  issues: PluginIssue[]
}

/** `POST admin/validate`. */
export interface ValidateResponse {
  /** False iff any issue is an error. */
  ok: boolean
  issues: PluginIssue[]
}

/** `POST admin/save`. */
export type SaveResponse
  = | {
    saved: true
    revision: string
    config: ConfigDocument
    /** Warnings only: a save with an error is not written. */
    issues: PluginIssue[]
    /** The cron tasks the save created or removed, or `null` when reconciling failed (see `scheduleError`). */
    schedule: ScheduleReconcile | null
    scheduleError?: string
  }
  | { saved: false, reason: 'invalid', issues: PluginIssue[] }
  /** Someone saved since `revision` was read. Nothing was written; `config`, `revision` and `issues` are the current ones. */
  | ({ saved: false, reason: 'stale' } & ConfigResponse)

/** `POST admin/test`. */
export type TestResponse
  = | { tested: true, result: CheckResult }
    /** `issues` use paths relative to the monitor (`url`, `sentry.org`). */
    | { tested: false, reason: 'invalid', message: string, issues: PluginIssue[] }
    | { tested: false, reason: 'not-found' | 'webhook-only' | 'no-token' | 'no-network', message: string }

/** `GET admin/overview`. */
export interface OverviewResponse {
  /** False while no configuration is stored or the stored one is rejected. `monitors` is then empty. */
  configured: boolean
  /** Why the stored configuration is rejected (errors only). */
  configIssues: PluginIssue[]
  /** Time of the newest result, or `null` before the first check. */
  updatedAt: string | null
  /** The overall severity, ignoring monitors that are not checked yet. */
  status: StatusResponse['status']
  /** Every configured monitor. `pending: true` marks one that was never checked. */
  monitors: SiteSummary[]
}

type AdminContext = Pick<PluginContext, 'settings' | 'kv' | 'cron' | 'http'>

export interface AdminOptions {
  /** The client for header-only probes, behind the host's SSRF guard. Defaults to {@link createProbeHttp}. */
  probeHttp?: Pick<HttpAccess, 'fetch'>
  /** The client for checks that read a body. Defaults to `ctx.http`. */
  bodyHttp?: Pick<HttpAccess, 'fetch'>
  now?: () => Date
  deadlineMs?: number
}

/** The host holds a revision of 1 to 128 characters; anything else is a malformed request. */
const MAX_REVISION_LENGTH = 128

const encoder = new TextEncoder()

function secretsSetFrom(values: Map<string, unknown>): SecretsSet {
  const isSet = (key: string) => {
    const value = values.get(key)
    return typeof value === 'string' && value.trim() !== ''
  }
  return {
    [SLACK_SECRET_KEY]: isSet(SLACK_SECRET_KEY),
    [WEBHOOKS_SECRET_KEY]: isSet(WEBHOOKS_SECRET_KEY),
    [WEBHOOK_SECRET_KEY]: isSet(WEBHOOK_SECRET_KEY),
    [SENTRY_TOKEN_SECRET_KEY]: isSet(SENTRY_TOKEN_SECRET_KEY),
  }
}

async function settingsOf(ctx: Pick<PluginContext, 'settings'>): Promise<Map<string, unknown>> {
  return new Map((await ctx.settings.list()).map(entry => [entry.key, entry.value]))
}

function isDocument(value: unknown): value is ConfigDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function error(path: string, message: string): PluginIssue {
  return { severity: 'error', path, message }
}

/**
 * The YAML for an edited configuration, or the reason it cannot be stored. The
 * document must be an object and its YAML must fit {@link MAX_YAML_BYTES}.
 */
function serialize(config: unknown): { yaml: string } | { issues: PluginIssue[] } {
  if (!isDocument(config)) {
    return { issues: [error('', 'The configuration must be an object with a name and a list of sites.')] }
  }
  // No line folding: a folded long value is harder to read and to diff.
  const yaml = stringifyYaml(config, { lineWidth: 0 })
  const bytes = encoder.encode(yaml).byteLength
  if (bytes > MAX_YAML_BYTES) {
    return { issues: [error('', `The configuration is ${bytes} bytes as YAML and the limit is ${MAX_YAML_BYTES} bytes (64 KiB). Nothing was validated or saved. Remove monitors or shorten values.`)] }
  }
  return { yaml }
}

/** Read the stored configuration the way the editor needs it: parsed, with its revision and findings. */
async function readConfig(ctx: Pick<PluginContext, 'settings'>): Promise<ConfigResponse> {
  const stored = await ctx.settings.getVersioned<string>(CONFIG_SETTINGS_KEY)
  const values = await settingsOf(ctx)
  const secretsSet = secretsSetFrom(values)
  const yaml = typeof stored?.value === 'string' ? stored.value : ''
  const revision = stored?.revision ?? null
  if (yaml.trim() === '') {
    return { config: null, revision, secretsSet, issues: [] }
  }
  const issues = validatePluginConfig(yaml, secretsFrom(values).secrets).issues
  if (encoder.encode(yaml).byteLength > MAX_YAML_BYTES) {
    return { config: null, revision, secretsSet, issues: [error('', `The stored configuration is larger than the ${MAX_YAML_BYTES} bytes the editor holds. It is left unchanged.`), ...issues] }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
    // A recursive alias parses to a cyclic object that cannot be sent as JSON.
    JSON.stringify(parsed)
  }
  catch {
    parsed = null
  }
  if (parsed === null && !issues.some(issue => issue.severity === 'error')) {
    issues.push(error('', 'The stored configuration cannot be shown in the editor (for example a recursive YAML alias). It is left unchanged.'))
  }
  return { config: isDocument(parsed) ? parsed : null, revision, secretsSet, issues }
}

async function validateDocument(ctx: Pick<PluginContext, 'settings'>, config: unknown): Promise<ValidateResponse & { yaml?: string }> {
  const serialized = serialize(config)
  if ('issues' in serialized) {
    return { ok: false, issues: serialized.issues }
  }
  const { secrets } = secretsFrom(await settingsOf(ctx))
  const validation = validatePluginConfig(serialized.yaml, secrets)
  return { ok: validation.ok, issues: validation.issues, yaml: serialized.yaml }
}

/**
 * Save: validate first and write nothing when it fails, then write the YAML with
 * `compareAndSet` against the revision the editor was loaded with. A stale
 * revision writes nothing and answers with the current configuration. A saved
 * configuration reconciles the cron tasks (creating only a missing or changed
 * one) and drops an earlier run-time configuration error.
 */
async function save(ctx: AdminContext, input: { config: unknown, revision: string | null }): Promise<SaveResponse> {
  const validation = await validateDocument(ctx, input.config)
  if (!validation.ok || validation.yaml === undefined) {
    return { saved: false, reason: 'invalid', issues: validation.issues }
  }
  const written = await ctx.settings.compareAndSet(CONFIG_SETTINGS_KEY, input.revision, validation.yaml)
  if (!written.applied) {
    return { saved: false, reason: 'stale', ...await readConfig(ctx) }
  }
  let schedule: ScheduleReconcile | null = null
  let scheduleError: string | undefined
  try {
    schedule = await reconcileSchedule(ctx)
    await clearConfigError(ctx)
  }
  catch (cause) {
    scheduleError = cause instanceof Error ? cause.message : 'Unknown error'
  }
  return {
    saved: true,
    revision: written.revision,
    config: input.config as ConfigDocument,
    issues: validation.issues,
    schedule,
    ...(scheduleError === undefined ? {} : { scheduleError }),
  }
}

/** A finding from the one-monitor document, with `sites[0].` removed so the path is relative to the monitor. */
function relativeIssue(issue: PluginIssue): PluginIssue {
  return { ...issue, path: issue.path.replace(/^sites\[0\]\.?/, '') }
}

async function resolveSite(ctx: Pick<PluginContext, 'settings'>, input: TestInput): Promise<{ site: Site, values: Map<string, unknown> } | TestResponse> {
  const values = await settingsOf(ctx)
  const { secrets } = secretsFrom(values)
  if (input.monitor !== undefined) {
    const serialized = serialize({ name: 'test', sites: [input.monitor] })
    const validation = 'yaml' in serialized ? validatePluginConfig(serialized.yaml, secrets) : undefined
    const site = validation?.config?.sites[0]
    if (!site) {
      const issues = (validation?.issues ?? ('issues' in serialized ? serialized.issues : [])).filter(issue => issue.severity === 'error').map(relativeIssue)
      return { tested: false, reason: 'invalid', message: 'The monitor is not valid. Fix the errors, then test again.', issues }
    }
    return { site, values }
  }
  const stored = values.get(CONFIG_SETTINGS_KEY)
  const validation = typeof stored === 'string' && stored.trim() !== '' ? validatePluginConfig(stored, secrets) : undefined
  if (validation && !validation.config) {
    const issues = validation.issues.filter(issue => issue.severity === 'error')
    return { tested: false, reason: 'invalid', message: 'The saved configuration is not valid. Fix the errors and save, then test again.', issues }
  }
  const config = validation?.config
  const site = config?.sites.find(candidate => candidate.slug === input.slug)
  if (!site) {
    return { tested: false, reason: 'not-found', message: `No monitor in the saved configuration has the slug "${input.slug}".` }
  }
  return { site, values }
}

/**
 * Test one monitor, from the saved configuration (`slug`) or an unsaved edit
 * (`monitor`), with the same probe the scheduled run uses. It reads settings and
 * makes the probe request; it writes no bucket, snapshot, key-value entry or
 * setting and delivers no notification.
 */
async function testMonitor(ctx: AdminContext, input: TestInput, options: AdminOptions): Promise<TestResponse> {
  const resolved = await resolveSite(ctx, input)
  if ('tested' in resolved) {
    return resolved
  }
  const { site, values } = resolved
  const token = values.get(SENTRY_TOKEN_SECRET_KEY)
  const sentryToken = typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined
  if (site.check === 'sentry' && site.sentry === undefined) {
    return { tested: false, reason: 'webhook-only', message: 'A Sentry monitor without a sentry block is updated by Sentry webhooks only. Add the organization to poll it, then test again.' }
  }
  if (site.check === 'sentry' && !sentryToken) {
    return { tested: false, reason: 'no-token', message: `This monitor polls Sentry, which needs the "${SENTRY_TOKEN_SECRET_KEY}" setting. Nothing was probed.` }
  }
  const bodyHttp = options.bodyHttp ?? ctx.http
  if (!bodyHttp) {
    return { tested: false, reason: 'no-network', message: 'This plugin has no network access: it needs the network:request:unrestricted capability.' }
  }
  const probeHttp = options.probeHttp ?? createProbeHttp(PLUGIN_ID)
  const http = BODY_CHECKS.has(site.check) ? bodyHttp : probeHttp
  const now = options.now ?? (() => new Date())
  const result = await probeSite((url, init) => http.fetch(url, init), site, options.deadlineMs ?? PROBE_DEADLINE_MS, () => now().getTime(), sentryToken)
  return { tested: true, result }
}

async function overview(ctx: Pick<PluginContext, 'settings' | 'kv'>, now: Date): Promise<OverviewResponse> {
  const stored = await loadStoredConfig(ctx)
  const merged = await readSnapshot(ctx)
  if (stored.status !== 'valid') {
    const configIssues = stored.status === 'invalid' ? stored.issues.filter(issue => issue.severity === 'error') : []
    return { configured: false, configIssues, updatedAt: merged.updatedAt, status: buildStatusResponse([], now).status, monitors: [] }
  }
  const monitors = summariesFromSnapshot(merged, stored.config.sites, now)
  return { configured: true, configIssues: [], updatedAt: merged.updatedAt, status: buildStatusResponse(monitors, now).status, monitors }
}

const configInput = z.object({ config: z.unknown() })
const saveInput = z.object({ config: z.unknown(), revision: z.string().min(1).max(MAX_REVISION_LENGTH).nullable() })
const testInput = z.union([
  z.object({ monitor: z.unknown().refine(value => value !== undefined), slug: z.undefined().optional() }),
  z.object({ slug: z.string().min(1), monitor: z.undefined().optional() }),
])
type TestInput = { monitor: unknown, slug?: undefined } | { slug: string, monitor?: undefined }

function getRoute(handler: PluginRoute['handler']): PluginRoute {
  return definePluginRoute({ permission: 'plugins:manage', methods: ['GET'], request: { body: 'none' }, handler }) as PluginRoute
}

function postRoute<T>(input: z.ZodType<T>, handler: (ctx: AdminContext, input: T) => Promise<unknown>): PluginRoute {
  return {
    permission: 'plugins:manage',
    methods: ['POST'],
    request: { body: 'json', maxBytes: MAX_REQUEST_BYTES },
    input,
    handler: ctx => handler(ctx, ctx.input as T),
  } as PluginRoute
}

/**
 * The admin-only routes. A route's response is the host's `{ success, data }`
 * envelope around the types above.
 */
export function adminRoutes(options: AdminOptions = {}): Record<string, PluginRoute> {
  const now = () => (options.now ?? (() => new Date()))()
  return {
    [ADMIN_ROUTE.config]: getRoute(ctx => readConfig(ctx)),
    [ADMIN_ROUTE.validate]: postRoute(configInput, async (ctx, input) => {
      const { ok, issues } = await validateDocument(ctx, input.config)
      return { ok, issues } satisfies ValidateResponse
    }),
    [ADMIN_ROUTE.save]: postRoute(saveInput, (ctx, input) => save(ctx, input)),
    [ADMIN_ROUTE.test]: postRoute(testInput, (ctx, input) => testMonitor(ctx, input as TestInput, options)),
    [ADMIN_ROUTE.overview]: getRoute(ctx => overview(ctx, now())),
  }
}
