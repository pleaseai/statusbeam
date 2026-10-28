import type { AdminDict } from '@statusbeam/core'
import type { PluginIssue } from '../config'
import type { ConfigDocument } from '../routes/admin'
import { slugify } from '@statusbeam/core'

/**
 * The editor's model of a configuration (FR-7).
 *
 * The editor works on the document as stored, with no defaults applied, and
 * touches only the keys it shows: a key it does not know (a `sentry` block, a
 * `theme`) is carried through a save unchanged.
 */

/** The fields of a monitor the editor shows, in display order. */
export const MONITOR_FIELDS = ['name', 'slug', 'check', 'url', 'method', 'expectedStatusCodes', 'maxResponseTime', 'component'] as const
export type MonitorField = (typeof MONITOR_FIELDS)[number]

/** Where a finding appears: `name` for the page name, `<row index>.<field>` for a monitor field. */
export type FieldKey = 'name' | `${number}.${MonitorField}`

export type Monitor = Record<string, unknown>

export interface MonitorRow {
  /** Stable React key; unrelated to the monitor's slug, which the user can edit. */
  key: string
  /** The monitor as stored or as edited, minus the two fields kept as text below. */
  monitor: Monitor
  /** What the user typed for `expectedStatusCodes`. */
  codesText: string
  /** The stored monitor had an explicit empty `expectedStatusCodes` (every response is down) and the user has not edited the field since. */
  emptyCodes?: boolean
  /** What the user typed for `maxResponseTime`. */
  maxText: string
  /** The slug this monitor had when it was loaded, or `null` for a monitor added in this session. Its history lives under it. */
  savedSlug: string | null
}

export interface Draft {
  /** The status page name. */
  name: string
  /** Top-level keys the editor does not show (`theme`, `notifications`, ...), kept as they are. */
  extras: Record<string, unknown>
  rows: MonitorRow[]
}

/** Findings keyed by the field they belong to, plus the ones that belong to none. */
export interface Findings {
  fields: Partial<Record<FieldKey, string>>
  /** Warnings, and errors on a path the editor has no field for. */
  other: PluginIssue[]
}

export const NO_FINDINGS: Findings = { fields: {}, other: [] }

let nextKey = 0
export function newRowKey(): string {
  nextKey += 1
  return `monitor-${nextKey}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The slug a monitor is stored under: its `slug`, else the slug derived from its name. Empty when neither gives one. */
export function effectiveSlug(monitor: Monitor): string {
  const slug = typeof monitor.slug === 'string' ? monitor.slug.trim() : ''
  return slug !== '' ? slug : slugify(typeof monitor.name === 'string' ? monitor.name : '')
}

/** A stored value as the text field shows it, so a wrongly typed one stays visible and is reported instead of dropped. */
function storedText(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function rowFrom(stored: unknown): MonitorRow {
  const { expectedStatusCodes, maxResponseTime, ...rest } = isRecord(stored) ? stored : {}
  const monitor: Monitor = rest
  const codesText = Array.isArray(expectedStatusCodes) ? expectedStatusCodes.join(', ') : storedText(expectedStatusCodes)
  const maxText = storedText(maxResponseTime)
  const emptyCodes = Array.isArray(expectedStatusCodes) && expectedStatusCodes.length === 0
  return { key: newRowKey(), monitor, codesText, maxText, savedSlug: effectiveSlug(monitor) || null, ...(emptyCodes ? { emptyCodes } : {}) }
}

/** The draft for a stored configuration. `null` (nothing stored) gives an empty draft. */
export function draftFromConfig(config: ConfigDocument | null): Draft {
  const { name, sites, ...extras } = config ?? {}
  return {
    name: typeof name === 'string' ? name : '',
    extras,
    rows: Array.isArray(sites) ? sites.map(rowFrom) : [],
  }
}

export function newRow(): MonitorRow {
  return { key: newRowKey(), monitor: { name: '', check: 'http' }, codesText: '', maxText: '', savedSlug: null }
}

type NumberProblem = 'wholeNumber' | 'wholeNumbers'

function parseWhole(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null
}

/**
 * The monitor as it would be saved, and the numeric fields whose text is not a
 * number. An empty text drops the key, so the stored document stays free of
 * empty values and the schema's defaults apply.
 */
export function buildMonitor(row: MonitorRow): { monitor: Monitor, problems: Partial<Record<'expectedStatusCodes' | 'maxResponseTime', NumberProblem>> } {
  const monitor: Monitor = { ...row.monitor }
  for (const field of ['slug', 'url', 'method', 'component'] as const) {
    const value = monitor[field]
    if (typeof value === 'string' && value.trim() === '') {
      delete monitor[field]
    }
  }
  const problems: ReturnType<typeof buildMonitor>['problems'] = {}

  const codes = row.codesText.split(/[\s,]+/).filter(Boolean)
  if (codes.length === 0 && row.emptyCodes) {
    monitor.expectedStatusCodes = []
  }
  else if (codes.length > 0) {
    const parsed = codes.map(parseWhole)
    if (parsed.every((value): value is number => value !== null)) {
      monitor.expectedStatusCodes = parsed
    }
    else {
      problems.expectedStatusCodes = 'wholeNumbers'
    }
  }

  const max = row.maxText.trim()
  if (max !== '') {
    const parsed = parseWhole(max)
    if (parsed !== null) {
      monitor.maxResponseTime = parsed
    }
    else {
      problems.maxResponseTime = 'wholeNumber'
    }
  }
  return { monitor, problems }
}

/** The configuration document the draft stands for. */
export function buildConfig(draft: Draft): ConfigDocument {
  return { name: draft.name, ...draft.extras, sites: draft.rows.map(row => buildMonitor(row).monitor) }
}

/** The findings the editor itself can raise before it asks the server: a text that is no number, and a slug two monitors share. */
export function clientFindings(draft: Draft, t: AdminDict): Findings {
  const fields: Findings['fields'] = {}
  draft.rows.forEach((row, index) => {
    for (const [field, problem] of Object.entries(buildMonitor(row).problems)) {
      fields[`${index}.${field as MonitorField}`] = problem === 'wholeNumbers' ? t.monitors.wholeNumbers : t.monitors.wholeNumber
    }
  })
  const owners = new Map<string, number[]>()
  draft.rows.forEach((row, index) => {
    const slug = effectiveSlug(row.monitor)
    if (slug !== '') {
      owners.set(slug, [...owners.get(slug) ?? [], index])
    }
  })
  for (const [slug, indexes] of owners) {
    if (indexes.length > 1) {
      for (const index of indexes) {
        fields[`${index}.slug`] = t.monitors.duplicateSlug(slug)
      }
    }
  }
  return { fields, other: [] }
}

export function hasFindings(findings: Findings): boolean {
  return Object.keys(findings.fields).length > 0 || findings.other.some(issue => issue.severity === 'error')
}

const SITE_ROW_PATH = /^sites\[(\d+)\]/
const SITE_PATH = /^sites\[(\d+)\]\.([A-Z_]\w*)/i

/** Where an issue path lands: a field of the editor, or `null` when the editor has no field for it. */
export function fieldKeyOf(path: string): FieldKey | null {
  if (path === 'name') {
    return 'name'
  }
  const match = SITE_PATH.exec(path)
  const field = match?.[2] as MonitorField | undefined
  return match && field && (MONITOR_FIELDS as readonly string[]).includes(field) ? `${Number(match[1])}.${field}` : null
}

/** Sort a server's issues onto the editor's fields. The first error on a field wins; warnings stay in the list. */
export function findingsFromIssues(issues: PluginIssue[]): Findings {
  const fields: Findings['fields'] = {}
  const other: PluginIssue[] = []
  for (const issue of issues) {
    const key = issue.severity === 'error' ? fieldKeyOf(issue.path) : null
    if (key === null) {
      other.push(issue)
    }
    else {
      fields[key] ??= issue.message
    }
  }
  return { fields, other }
}

/** The findings after a monitor row is removed: its own are dropped and those of the rows after it move up one index, in `other` as well as on the fields. */
export function findingsWithoutRow(findings: Findings, removed: number): Findings {
  const fields: Findings['fields'] = {}
  for (const [key, message] of Object.entries(findings.fields) as Array<[FieldKey, string]>) {
    const [row, field] = key.split('.')
    if (field === undefined) {
      fields[key] = message
    }
    else if (Number(row) !== removed) {
      fields[Number(row) > removed ? `${Number(row) - 1}.${field}` as FieldKey : key] = message
    }
  }
  const other = findings.other.flatMap((issue): PluginIssue[] => {
    const match = SITE_ROW_PATH.exec(issue.path)
    if (!match) {
      return [issue]
    }
    const row = Number(match[1])
    if (row === removed) {
      return []
    }
    return [row > removed ? { ...issue, path: `sites[${row - 1}]${issue.path.slice(match[0].length)}` } : issue]
  })
  return { fields, other }
}

/** True when the monitor carries settings the editor has no field for (a `sentry` or `aigateway` block). */
export function hasHiddenSettings(monitor: Monitor): boolean {
  return Object.keys(monitor).some(key => !(MONITOR_FIELDS as readonly string[]).includes(key))
}

/** The settings block that is only valid with one check kind. */
const KIND_BLOCKS = { sentry: 'sentry', aigateway: 'aigateway' } as const

/** Changes a monitor's check kind, dropping hidden settings blocks the new kind does not allow (core rejects them). */
export function withCheckKind(monitor: Monitor, check: string): Monitor {
  const next: Monitor = { ...monitor, check }
  if (monitor.check === check) {
    return next
  }
  for (const [block, kind] of Object.entries(KIND_BLOCKS)) {
    if (check !== kind) {
      delete next[block]
    }
  }
  return next
}

/** Whether saving this monitor would store it as a new one: it had a slug when loaded and has a different one now. */
export function isRenamed(row: MonitorRow): boolean {
  return row.savedSlug !== null && effectiveSlug(row.monitor) !== row.savedSlug
}
