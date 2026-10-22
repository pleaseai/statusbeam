import type { Block, BlockResponse } from '@emdash-cms/blocks'
import type { CheckResult, SiteSummary } from '@statusbeam/core'
import type { ConfigErrorRecord, PluginIssue } from './config'
import type { MergedSnapshot } from './snapshot'
import { overallSeverity, toSeverity } from '@statusbeam/core'

/**
 * Block Kit views for the admin page and the dashboard widget. Pure: every
 * function here builds blocks from values the handlers in `admin.ts` read.
 */

/** Path of the configuration page (`admin.pages` in `emdash-plugin.jsonc`). */
export const CONFIG_PAGE = '/config'

/** Id of the dashboard widget (`admin.widgets`); the host loads it as page `widget:{id}`. */
export const STATUS_WIDGET = 'status'

/** The single submit of the configuration form. */
export const RUN_ACTION = 'run'

/** Button that reloads the page and the stored revision. */
export const RELOAD_ACTION = 'reload'

/**
 * Block Kit rejects a response with any string above 64 KiB (UTF-8 bytes,
 * `BLOCK_RESPONSE_LIMITS.maxStringBytes` in `@emdash-cms/blocks`). The YAML is
 * one `text_input` value, so it can never be larger than this to be edited.
 */
export const MAX_YAML_BYTES = 64 * 1024

/** Text blocks carrying issue lists stay well under the string limit. */
const MAX_TEXT_CHUNK_BYTES = 16 * 1024

/** What the form's single submit does. The form carries the unsaved YAML, so the choice rides along with it. */
export type Operation = 'validate' | 'save' | 'test'

export const OPERATIONS: Array<{ value: Operation, label: string }> = [
  { value: 'validate', label: 'Validate (check without saving)' },
  { value: 'save', label: 'Save (only when valid)' },
  { value: 'test', label: 'Test site (one check, saves nothing)' },
]

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** One outcome message shown above the form. */
export interface Notice {
  variant: 'default' | 'alert' | 'error'
  title: string
  description?: string
}

/** The Test site outcome. */
export interface TestOutcome {
  slug: string
  /** Which configuration the monitor came from. */
  source: 'editor' | 'stored'
  result: CheckResult
}

export interface ConfigPageState {
  /** The YAML the form shows: the stored one on load, the submitted one after an action. */
  yaml: string
  operation: Operation
  slug: string
  /** Outcome of the action, if any. */
  notices: Notice[]
  /** Validation issues of the action, errors first. */
  issues: PluginIssue[]
  test?: TestOutcome
  /** The run-time configuration error T008 records. */
  configError?: ConfigErrorRecord | null
  /** Notes from the snapshot: body-limit warnings and capacity errors. */
  snapshotNotes?: string[]
  /** Re-keys the form so the host remounts it with these initial values. */
  formKey: string
}

/** Split lines into texts below the chunk size, so no single string nears the Block Kit limit. */
function chunkLines(lines: string[]): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    const bytes = byteLength(line) + 1
    if (current.length > 0 && size + bytes > MAX_TEXT_CHUNK_BYTES) {
      chunks.push(current.join('\n'))
      current = []
      size = 0
    }
    current.push(line)
    size += bytes
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'))
  }
  return chunks
}

/** One line per issue: severity, path, message. Every issue is listed, none is dropped. */
export function issueLines(issues: PluginIssue[]): string[] {
  const ordered = [...issues.filter(i => i.severity === 'error'), ...issues.filter(i => i.severity === 'warning')]
  return ordered.map(issue => `${issue.severity === 'error' ? 'Error' : 'Warning'} at ${issue.path === '' ? '(document)' : issue.path}: ${issue.message}`)
}

function issueBlocks(issues: PluginIssue[]): Block[] {
  if (issues.length === 0) {
    return []
  }
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.length - errors
  return [
    { type: 'header', text: `Issues: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` },
    ...chunkLines(issueLines(issues)).map(text => ({ type: 'code' as const, code: text, language: 'bash' as const })),
  ]
}

function configErrorBlocks(record: ConfigErrorRecord | null | undefined): Block[] {
  if (!record) {
    return []
  }
  return [
    {
      type: 'banner',
      variant: 'error',
      title: 'The stored configuration failed validation at run time',
      description: `Scheduled checks are paused since ${record.recordedAt}. Fix the issues below and save a valid configuration to resume.`,
    },
    ...chunkLines(issueLines(record.issues)).map(text => ({ type: 'code' as const, code: text, language: 'bash' as const })),
  ]
}

function testBlocks(test: TestOutcome | undefined): Block[] {
  if (!test) {
    return []
  }
  const { result } = test
  const fields = [
    { label: 'Monitor', value: test.slug },
    { label: 'Status', value: result.limit === 'body' ? 'unsupported (response body above the host limit)' : result.status },
    { label: 'HTTP code', value: result.code === 0 ? '0 (no response)' : String(result.code) },
    { label: 'Latency', value: `${result.responseTime} ms` },
    { label: 'Configuration', value: test.source === 'editor' ? 'the YAML in the editor' : 'the stored configuration (the editor YAML is invalid)' },
  ]
  if (result.error) {
    fields.push({ label: 'Error', value: result.error })
  }
  return [
    { type: 'header', text: 'Test site result' },
    { type: 'fields', fields },
    { type: 'context', text: 'Test site writes no history and changes no status.' },
  ]
}

function noticeBlock(notice: Notice): Block {
  return { type: 'banner', variant: notice.variant, title: notice.title, ...(notice.description ? { description: notice.description } : {}) }
}

/** The configuration page. */
export function configPage(state: ConfigPageState): Block[] {
  return [
    { type: 'header', text: 'StatusBeam configuration' },
    ...configErrorBlocks(state.configError),
    ...(state.snapshotNotes ?? []).map(note => ({ type: 'banner' as const, variant: 'alert' as const, description: note })),
    ...state.notices.map(noticeBlock),
    ...issueBlocks(state.issues),
    ...testBlocks(state.test),
    {
      type: 'form',
      block_id: `config-${state.formKey}`,
      fields: [
        { type: 'text_input', action_id: 'yaml', label: 'Configuration (YAML)', multiline: true, initial_value: state.yaml },
        { type: 'select', action_id: 'operation', label: 'Action', options: OPERATIONS, initial_value: state.operation },
        {
          type: 'text_input',
          action_id: 'slug',
          label: 'Monitor slug for Test site',
          placeholder: 'e.g. api',
          initial_value: state.slug,
          condition: { field: 'operation', eq: 'test' },
        },
      ],
      submit: { label: 'Run', action_id: RUN_ACTION },
    },
    {
      type: 'context',
      text: `Notification URLs and the Sentry token live in the plugin settings, not in the YAML. The YAML is limited to ${MAX_YAML_BYTES / 1024} KiB.`,
    },
  ]
}

/** The stale-save refusal: keep the editor text, offer a reload. */
export function reloadActions(): Block {
  return { type: 'actions', elements: [{ type: 'button', action_id: RELOAD_ACTION, label: 'Reload', style: 'primary' }] }
}

/** Body-limit warnings and capacity errors from the merged snapshot. */
export function snapshotNotes(merged: MergedSnapshot): string[] {
  const notes: string[] = []
  for (const monitor of merged.monitors.values()) {
    if (monitor.warning?.limit === 'body') {
      notes.push(`Monitor "${monitor.slug}" is unsupported since ${monitor.warning.since}: its response body exceeds the host's size limit, so it is not graded.`)
    }
  }
  return [...notes, ...merged.capacityErrors]
}

/** The refusal for a caller who is not an administrator: nothing about the plugin. */
export function refusal(): BlockResponse {
  return {
    blocks: [{ type: 'banner', variant: 'error', title: 'Administrators only', description: 'Only an administrator can use the StatusBeam page and widget.' }],
    toast: { type: 'error', message: 'Only administrators can use this page.' },
  }
}

/** The severities `toSeverity` and `overallSeverity` produce. */
type CheckSeverity = 'operational' | 'degraded' | 'major_outage'

const SEVERITY_LABELS: Record<CheckSeverity, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  major_outage: 'Major outage',
}

/** The dashboard widget: overall status and how many monitors are at each severity (FR-12). */
export function statusWidget(summaries: SiteSummary[] | null, updatedAt: string | null): Block[] {
  if (summaries === null) {
    return [{ type: 'empty', title: 'No valid configuration', description: 'Open the StatusBeam page to add monitors.' }]
  }
  if (summaries.length === 0) {
    return [{ type: 'empty', title: 'No monitors', description: 'The configuration lists no sites.' }]
  }
  const counts: Record<CheckSeverity, number> = { operational: 0, degraded: 0, major_outage: 0 }
  for (const summary of summaries) {
    counts[toSeverity(summary.status) as CheckSeverity] += 1
  }
  const overall = overallSeverity(summaries.map(summary => summary.status))
  return [
    {
      type: 'banner',
      variant: overall === 'operational' ? 'default' : overall === 'degraded' ? 'alert' : 'error',
      title: `Overall: ${SEVERITY_LABELS[overall as CheckSeverity]}`,
      description: `${summaries.length} monitor${summaries.length === 1 ? '' : 's'}`,
    },
    {
      type: 'stats',
      items: (Object.keys(SEVERITY_LABELS) as CheckSeverity[]).map(severity => ({ label: SEVERITY_LABELS[severity], value: counts[severity] })),
    },
    { type: 'context', text: updatedAt ? `Last check ${updatedAt}` : 'No check has run yet.' },
  ]
}
