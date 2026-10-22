import type { BlockResponse } from '@emdash-cms/blocks'
import type { PluginContext, RouteEntry, RouteHandler } from 'emdash/plugin'
import type { ConfigPageState, Notice, Operation, TestOutcome } from './admin-view'
import type { PluginIssue, PluginValidation } from './config'
import { byteLength, CONFIG_PAGE, configPage, MAX_YAML_BYTES, OPERATIONS, refusal, RELOAD_ACTION, reloadActions, RUN_ACTION, snapshotNotes, STATUS_WIDGET, statusWidget } from './admin-view'
import { CALL_BUDGET } from './budget'
import { readConfigError, secretsFrom, validatePluginConfig } from './config'
import { probeSite } from './probe'
import { CONFIG_SETTINGS_KEY, readSettings } from './settings'
import { reconcileShards } from './shards'
import { readSnapshot, summariesFromSnapshot } from './snapshot'

/** `Role.ADMIN` in `@emdash-cms/auth`. The host also gates the route with `plugins:manage`, which only this role holds; the handler asserts it again. */
const ADMIN_ROLE = 50

/** The page's loaded configuration revision, one record per user: Block Kit has no hidden field to carry it. */
function revisionKey(userId: string): string {
  return `admin:rev:${userId}`
}

interface LoadedRevision {
  /** The settings revision the page showed, or `null` when no configuration was stored. */
  revision: string | null
}

const STALE_MESSAGE = 'The configuration changed since you loaded this page. Reload to see the current configuration, then apply your edit again. Nothing was saved.'

type AdminContext = Pick<PluginContext, 'settings' | 'kv' | 'cron' | 'http'>
type RouteContext = Parameters<RouteHandler>[0]
type User = RouteContext['user']

interface Interaction {
  type: string
  actionId: string
  page: string
  values: Record<string, unknown>
}

/** The Block Kit interaction as the host forwards it; anything unrecognized reads as a page load. */
function parseInteraction(input: unknown): Interaction {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const values = typeof record.values === 'object' && record.values !== null ? record.values as Record<string, unknown> : {}
  return {
    type: typeof record.type === 'string' ? record.type : 'page_load',
    actionId: typeof record.action_id === 'string' ? record.action_id : '',
    page: typeof record.page === 'string' ? record.page : CONFIG_PAGE,
    values,
  }
}

function operationOf(value: unknown): Operation {
  return OPERATIONS.find(operation => operation.value === value)?.value ?? 'validate'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Banner inputs: the run-time configuration error and the snapshot's notes (two bridge calls). */
async function loadBanners(ctx: AdminContext): Promise<Pick<ConfigPageState, 'configError' | 'snapshotNotes'>> {
  const configError = await readConfigError(ctx)
  const merged = await readSnapshot(ctx)
  return { configError, snapshotNotes: snapshotNotes(merged) }
}

function blankState(overrides: Partial<ConfigPageState>): ConfigPageState {
  return { yaml: '', operation: 'validate', slug: '', notices: [], issues: [], formKey: 'config', ...overrides }
}

function respond(state: ConfigPageState, toast?: BlockResponse['toast'], extra: BlockResponse['blocks'] = []): BlockResponse {
  return { blocks: [...configPage(state), ...extra], ...(toast ? { toast } : {}) }
}

/** Load (or reload) the page: the stored YAML, its revision recorded for this user, and the banners. 4 bridge calls. */
async function loadPage(ctx: AdminContext, userId: string, notices: Notice[] = []): Promise<BlockResponse> {
  const stored = await ctx.settings.getVersioned<string>(CONFIG_SETTINGS_KEY)
  await ctx.kv.set(revisionKey(userId), { revision: stored?.revision ?? null } satisfies LoadedRevision)
  const banners = await loadBanners(ctx)
  const yaml = typeof stored?.value === 'string' ? stored.value : ''
  const tooLarge = byteLength(yaml) > MAX_YAML_BYTES
  return respond(blankState({
    yaml: tooLarge ? '' : yaml,
    notices: tooLarge
      ? [...notices, { variant: 'alert', title: 'The stored configuration is too large to edit here', description: `It is ${byteLength(yaml)} bytes and the editor holds at most ${MAX_YAML_BYTES} bytes. It is left unchanged.` }]
      : notices,
    formKey: `config-${Date.now().toString(36)}`,
    ...banners,
  }))
}

function tooLargeResponse(yaml: string): BlockResponse {
  return respond(blankState({
    notices: [{
      variant: 'error',
      title: 'The configuration is too large',
      description: `The YAML is ${byteLength(yaml)} bytes and the limit is ${MAX_YAML_BYTES} bytes (64 KiB). Nothing was validated, saved or truncated. Shorten the YAML, then run again.`,
    }],
  }), { type: 'error', message: 'The configuration is larger than 64 KiB. Nothing was saved.' })
}

function issueCounts(issues: PluginIssue[]): { errors: number, warnings: number } {
  const errors = issues.filter(issue => issue.severity === 'error').length
  return { errors, warnings: issues.length - errors }
}

/** Validation against the stored secrets: one `settings.list`. */
async function validate(ctx: AdminContext, yaml: string): Promise<{ validation: PluginValidation, values: Map<string, unknown> }> {
  const values = new Map((await ctx.settings.list()).map(entry => [entry.key, entry.value]))
  return { validation: validatePluginConfig(yaml, secretsFrom(values).secrets), values }
}

function validationOutcome(validation: PluginValidation, success: Notice): { notices: Notice[], toast: NonNullable<BlockResponse['toast']> } {
  const { errors, warnings } = issueCounts(validation.issues)
  if (errors > 0) {
    return {
      notices: [{ variant: 'error', title: `${errors} error${errors === 1 ? '' : 's'} found`, description: 'Nothing was saved. Fix every error listed below.' }],
      toast: { type: 'error', message: `${errors} configuration error${errors === 1 ? '' : 's'}. Nothing was saved.` },
    }
  }
  return {
    notices: [success],
    toast: { type: 'success', message: warnings > 0 ? `${success.title} with ${warnings} warning${warnings === 1 ? '' : 's'}` : success.title },
  }
}

/** Validate (FR-16): 3 bridge calls (settings.list plus the banners), and no write. */
async function runValidate(ctx: AdminContext, values: Record<string, unknown>): Promise<BlockResponse> {
  const yaml = text(values.yaml)
  if (byteLength(yaml) > MAX_YAML_BYTES) {
    return tooLargeResponse(yaml)
  }
  const { validation } = await validate(ctx, yaml)
  const outcome = validationOutcome(validation, { variant: 'default', title: 'The configuration is valid', description: 'Nothing was saved. Choose Save to apply it.' })
  return respond(blankState({ yaml, operation: 'validate', slug: text(values.slug), issues: validation.issues, notices: outcome.notices, ...await loadBanners(ctx) }), outcome.toast)
}

function staleResponse(yaml: string, slug: string, banners: Awaited<ReturnType<typeof loadBanners>>): BlockResponse {
  return respond(
    blankState({ yaml, operation: 'save', slug, notices: [{ variant: 'error', title: 'The configuration changed', description: STALE_MESSAGE }], ...banners }),
    { type: 'error', message: 'The configuration changed since you loaded this page. Reload it.' },
    [reloadActions()],
  )
}

/**
 * Save (FR-15). Validation first; an invalid configuration writes nothing
 * (AC-014, AC-015). A valid one is written with `compareAndSet` against the
 * revision this user's page load recorded, so a save after someone else's is
 * refused (AC-016). Then the shard schedule follows the new configuration.
 *
 * Calls: settings.list, kv.get, compareAndSet, kv.set, then `reconcileShards`
 * with the rest of the budget (its own list, cron.list and error clear, plus
 * up to 3 schedule or cancel operations; the daily maintenance task finishes any
 * it defers). An invalid or stale save adds the 2 banner reads.
 */
async function runSave(ctx: AdminContext, userId: string, values: Record<string, unknown>): Promise<BlockResponse> {
  const yaml = text(values.yaml)
  const slug = text(values.slug)
  if (byteLength(yaml) > MAX_YAML_BYTES) {
    return tooLargeResponse(yaml)
  }
  const { validation } = await validate(ctx, yaml)
  if (!validation.ok) {
    const outcome = validationOutcome(validation, { variant: 'default', title: '' })
    return respond(blankState({ yaml, operation: 'save', slug, issues: validation.issues, notices: outcome.notices, ...await loadBanners(ctx) }), outcome.toast)
  }

  const loaded = await ctx.kv.get<LoadedRevision>(revisionKey(userId))
  const written = loaded ? await ctx.settings.compareAndSet(CONFIG_SETTINGS_KEY, loaded.revision, yaml) : null
  if (!written?.applied) {
    return staleResponse(yaml, slug, await loadBanners(ctx))
  }
  await ctx.kv.set(revisionKey(userId), { revision: written.revision } satisfies LoadedRevision)

  const notices: Notice[] = [{ variant: 'default', title: 'Configuration saved' }]
  try {
    const reconciled = await reconcileShards(ctx, { budget: CALL_BUDGET - 4, clearConfigError: true })
    if (reconciled.deferred > 0) {
      notices.push({
        variant: 'alert',
        title: 'Some scheduled tasks are still pending',
        description: `${reconciled.deferred} scheduling operation${reconciled.deferred === 1 ? '' : 's'} did not fit this request's call budget. The daily maintenance task finishes them, or save again now.`,
      })
    }
    if (reconciled.uncovered > 0) {
      notices.push({ variant: 'alert', title: 'Some monitors are not checked', description: `${reconciled.uncovered} monitors exceed what the scheduled tasks can probe.` })
    }
  }
  catch (error) {
    notices.push({
      variant: 'alert',
      title: 'The configuration is saved, but the schedule was not updated',
      description: `${error instanceof Error ? error.message : 'Unknown error'}. The daily maintenance task retries.`,
    })
  }
  const { warnings } = issueCounts(validation.issues)
  return respond(
    blankState({ yaml, operation: 'save', slug, issues: validation.issues, notices, configError: null }),
    { type: 'success', message: warnings > 0 ? `Configuration saved with ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Configuration saved' },
  )
}

function testRefusal(yaml: string, slug: string, notice: Notice, issues: PluginIssue[] = []): BlockResponse {
  return respond(blankState({ yaml, operation: 'test', slug, issues, notices: [notice] }), { type: 'error', message: notice.title })
}

/**
 * Test site (FR-17): one probe of one monitor, from the editor YAML or, when
 * that is invalid, the stored configuration. It writes nothing (AC-026): no
 * bucket, snapshot, kv or settings write. Calls: settings.list, one fetch, and
 * the 2 banner reads.
 */
async function runTest(ctx: AdminContext, values: Record<string, unknown>): Promise<BlockResponse> {
  const yaml = text(values.yaml)
  const slug = text(values.slug).trim()
  if (byteLength(yaml) > MAX_YAML_BYTES) {
    return tooLargeResponse(yaml)
  }
  if (slug === '') {
    return testRefusal(yaml, slug, { variant: 'error', title: 'Enter the slug of the monitor to test' })
  }
  const { validation, values: settings } = await validate(ctx, yaml)
  let config = validation.config
  let source: TestOutcome['source'] = 'editor'
  if (!config) {
    const storedYaml = settings.get(CONFIG_SETTINGS_KEY)
    const stored = typeof storedYaml === 'string' && storedYaml.trim() !== '' ? validatePluginConfig(storedYaml, secretsFrom(settings).secrets) : undefined
    config = stored?.config
    source = 'stored'
  }
  if (!config) {
    return testRefusal(yaml, slug, { variant: 'error', title: 'There is no valid configuration to test', description: 'The editor YAML is invalid and no valid configuration is stored. Fix the errors below.' }, validation.issues)
  }
  const site = config.sites.find(candidate => candidate.slug === slug)
  if (!site) {
    const known = config.sites.slice(0, 20).map(candidate => candidate.slug).join(', ')
    return testRefusal(yaml, slug, { variant: 'error', title: `No monitor has the slug "${slug}"`, description: `Known slugs: ${known}${config.sites.length > 20 ? ', ...' : ''}` })
  }
  if (site.check === 'sentry') {
    return testRefusal(yaml, slug, { variant: 'alert', title: 'Sentry monitors cannot be tested here', description: 'They are updated by webhooks and a token-based poll, not by an HTTP probe.' })
  }
  const http = ctx.http
  if (!http) {
    return testRefusal(yaml, slug, { variant: 'error', title: 'This plugin has no network access', description: 'ctx.http is unavailable: the plugin needs the network:request:unrestricted capability.' })
  }
  const result = await probeSite((url, init) => http.fetch(url, init), site)
  const notices: Notice[] = source === 'stored'
    ? [{ variant: 'alert', title: 'Tested the stored configuration', description: 'The YAML in the editor is invalid, so the stored configuration was used.' }]
    : []
  return respond(
    blankState({ yaml, operation: 'test', slug, issues: source === 'stored' ? validation.issues : [], notices, test: { slug, source, result }, ...await loadBanners(ctx) }),
    { type: result.status === 'up' ? 'success' : 'info', message: `${slug}: ${result.status}, ${result.responseTime} ms` },
  )
}

/** The dashboard widget (FR-12): `readSettings` plus the snapshot list, 2 bridge calls. */
async function runWidget(ctx: AdminContext): Promise<BlockResponse> {
  const { config } = await readSettings(ctx)
  const merged = await readSnapshot(ctx)
  if (!config) {
    return { blocks: statusWidget(null, null) }
  }
  if (merged.updatedAt === null) {
    return { blocks: [{ type: 'empty', title: 'Waiting for the first check', description: `${config.sites.length} monitor${config.sites.length === 1 ? '' : 's'} configured.` }] }
  }
  return { blocks: statusWidget(summariesFromSnapshot(merged, config.sites, new Date()), merged.updatedAt) }
}

/** Whether the host-attested caller is an administrator. */
export function isAdministrator(user: User): boolean {
  return user !== undefined && user.role >= ADMIN_ROLE
}

/**
 * The `admin` route: the configuration page and the dashboard widget. Every
 * request is refused unless the host-attested user is an administrator
 * (AC-017), before any bridge call. The host gates the route with
 * `plugins:manage` as well; this is the assertion inside the plugin.
 */
export const adminHandler: RouteHandler = async (routeCtx, ctx) => {
  const user = routeCtx.user
  const interaction = parseInteraction(routeCtx.input)
  const isWidget = interaction.page.startsWith('widget:')
  if (!user || !isAdministrator(user)) {
    const denied = refusal()
    return isWidget ? { blocks: denied.blocks } : denied
  }
  if (isWidget) {
    return interaction.page === `widget:${STATUS_WIDGET}` ? runWidget(ctx) : { blocks: [] }
  }
  if (interaction.type === 'form_submit' && interaction.actionId === RUN_ACTION) {
    switch (operationOf(interaction.values.operation)) {
      case 'save':
        return runSave(ctx, user.id, interaction.values)
      case 'test':
        return runTest(ctx, interaction.values)
      default:
        return runValidate(ctx, interaction.values)
    }
  }
  if (interaction.type === 'block_action' && interaction.actionId === RELOAD_ACTION) {
    return loadPage(ctx, user.id, [{ variant: 'default', title: 'Reloaded the stored configuration' }])
  }
  return loadPage(ctx, user.id)
}

/** The route entry. `plugins:manage` is the route default; stated here so the manifest and this file agree. */
export const adminRoute: RouteEntry = { permission: 'plugins:manage', handler: adminHandler }
