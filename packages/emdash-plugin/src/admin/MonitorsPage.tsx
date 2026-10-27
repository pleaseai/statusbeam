import type { AdminDict } from '@statusbeam/core'
import type { ConfigResponse, SecretsSet } from '../routes/admin'
import type { Draft, FieldKey, Findings, MonitorField, MonitorRow } from './editor'
import { Banner, Button, Input, Select } from '@cloudflare/kumo'
import { checkKindSchema } from '@statusbeam/core'
import { useEffect, useState } from 'react'
import { AdminGate } from './AdminGate'
import { loadConfig, saveConfig, SETTINGS_PAGE_HREF } from './api'
import {
  buildConfig,
  buildMonitor,
  clientFindings,
  draftFromConfig,
  effectiveSlug,
  findingsFromIssues,
  hasFindings,
  hasHiddenSettings,
  isRenamed,
  newRow,
  NO_FINDINGS,
} from './editor'
import { useAdminDict } from './i18n'
import { MonitorActions } from './MonitorActions'

type Strings = AdminDict

/** What the editor last told the user about a save. */
type Notice = 'saved' | 'scheduleFailed' | 'invalid' | 'stale' | null

interface Loaded {
  draft: Draft
  revision: string | null
  secretsSet: SecretsSet
}

function loadedFrom(response: Pick<ConfigResponse, 'config' | 'revision' | 'secretsSet'>): Loaded {
  return { draft: draftFromConfig(response.config), revision: response.revision, secretsSet: response.secretsSet }
}

/** The monitors page: an administrator adds, edits and removes monitors and saves them (FR-7). */
export function MonitorsPage() {
  return (
    <AdminGate>
      <MonitorsEditor />
    </AdminGate>
  )
}

function MonitorsEditor() {
  const t = useAdminDict()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [findings, setFindings] = useState<Findings>(NO_FINDINGS)
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    loadConfig(t.loadFailed).then(
      (response) => {
        if (active) {
          setLoaded(loadedFrom(response))
          setFindings(findingsFromIssues(response.issues))
        }
      },
      (error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : t.loadFailed)
        }
      },
    )
    return () => {
      active = false
    }
    // The strings only matter for an error message; a locale switch must not refetch.
  }, [])

  if (loadError !== null) {
    return <div className="p-6"><Banner variant="error" description={loadError} role="alert" /></div>
  }
  if (loaded === null) {
    return <p className="p-6 text-sm text-kumo-subtle" role="status">{t.loading}</p>
  }

  const draft = loaded.draft
  const edit = (change: (current: Draft) => Draft) => {
    setLoaded(prev => prev && { ...prev, draft: change(prev.draft) })
    setNotice(null)
  }
  const editRow = (index: number, change: (row: MonitorRow) => MonitorRow) => {
    edit(current => ({ ...current, rows: current.rows.map((row, i) => (i === index ? change(row) : row)) }))
  }

  const save = async () => {
    setSaveError(null)
    setScheduleError(null)
    const local = clientFindings(draft, t)
    if (hasFindings(local)) {
      setFindings(local)
      setNotice('invalid')
      return
    }
    setSaving(true)
    try {
      const result = await saveConfig(buildConfig(draft), loaded.revision, t.monitors.saveFailed)
      if (result.saved) {
        setLoaded(loadedFrom({ config: result.config, revision: result.revision, secretsSet: loaded.secretsSet }))
        setFindings(findingsFromIssues(result.issues))
        if (result.scheduleError === undefined) {
          setNotice('saved')
        }
        else {
          setScheduleError(result.scheduleError)
          setNotice('scheduleFailed')
        }
      }
      else if (result.reason === 'invalid') {
        setFindings(findingsFromIssues(result.issues))
        setNotice('invalid')
      }
      else {
        setLoaded(loadedFrom(result))
        setFindings(findingsFromIssues(result.issues))
        setNotice('stale')
      }
    }
    catch (error) {
      setSaveError(error instanceof Error ? error.message : t.monitors.saveFailed)
    }
    finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="mx-auto max-w-4xl space-y-6 p-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <h1 className="text-2xl font-semibold">{t.monitors.title}</h1>

      {notice === 'saved' && <Banner variant="default" description={t.monitors.saved} role="status" />}
      {notice === 'scheduleFailed' && <Banner variant="alert" description={t.monitors.savedScheduleFailed(scheduleError ?? '')} role="alert" />}
      {notice === 'invalid' && <Banner variant="error" description={t.monitors.notSavedInvalid} role="alert" />}
      {notice === 'stale' && <Banner variant="alert" description={t.monitors.notSavedStale} role="alert" />}
      {saveError !== null && <Banner variant="error" description={saveError} role="alert" />}

      <fieldset disabled={saving} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <Input
          label={t.monitors.pageName}
          value={draft.name}
          error={findings.fields.name}
          onChange={event => edit(current => ({ ...current, name: event.target.value }))}
        />

        <section className="space-y-4" aria-labelledby="statusbeam-monitors-heading">
          <h2 id="statusbeam-monitors-heading" className="text-xl font-semibold">{t.monitors.heading}</h2>
          {draft.rows.length === 0 && <p className="text-sm text-kumo-subtle">{t.monitors.empty}</p>}
          {draft.rows.map((row, index) => (
            <MonitorCard
              key={row.key}
              t={t}
              index={index}
              row={row}
              findings={findings}
              busy={saving}
              onChange={change => editRow(index, change)}
              onRemove={() => edit(current => ({ ...current, rows: current.rows.filter((_, i) => i !== index) }))}
            />
          ))}
          <Button type="button" variant="secondary" disabled={saving} onClick={() => edit(current => ({ ...current, rows: [...current.rows, newRow()] }))}>
            {t.monitors.add}
          </Button>
        </section>
      </fieldset>

      <OtherFindings t={t} findings={findings} />

      <div className="flex items-center justify-end gap-3">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t.monitors.saving : t.monitors.save}
        </Button>
      </div>

      <Secrets t={t} secretsSet={loaded.secretsSet} />
    </form>
  )
}

interface MonitorCardProps {
  t: Strings
  index: number
  row: MonitorRow
  findings: Findings
  busy: boolean
  onChange: (change: (row: MonitorRow) => MonitorRow) => void
  onRemove: () => void
}

function MonitorCard({ t, index, row, findings, busy, onChange, onRemove }: MonitorCardProps) {
  const text = (field: MonitorField): string => {
    const value = row.monitor[field]
    return typeof value === 'string' ? value : ''
  }
  const errorOf = (field: MonitorField) => findings.fields[`${index}.${field}` as FieldKey]
  const set = (field: MonitorField, value: string) => onChange(current => ({ ...current, monitor: { ...current.monitor, [field]: value } }))
  const title = text('name') || t.monitors.monitorN(index + 1)
  const derived = effectiveSlug(row.monitor)
  const headingId = `statusbeam-monitor-${row.key}`

  return (
    <section className="space-y-4 rounded-lg border border-kumo-line p-4" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="min-w-0 truncate text-lg font-medium">{title}</h3>
        <Button type="button" variant="destructive" disabled={busy} onClick={onRemove}>
          {t.monitors.remove(title)}
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <Input label={t.monitors.field.name} value={text('name')} error={errorOf('name')} onChange={event => set('name', event.target.value)} />
        <Input
          label={t.monitors.field.slug}
          dir="ltr"
          value={text('slug')}
          placeholder={derived}
          error={errorOf('slug')}
          description={isRenamed(row) ? undefined : t.monitors.hint.slug}
          onChange={event => set('slug', event.target.value)}
        />
        <Select
          className="w-full"
          label={t.monitors.field.check}
          value={typeof row.monitor.check === 'string' ? row.monitor.check : 'http'}
          items={Object.fromEntries(checkKindSchema.options.map(kind => [kind, kind]))}
          error={errorOf('check')}
          onValueChange={value => onChange(current => ({ ...current, monitor: { ...current.monitor, check: value } }))}
        />
        <Input label={t.monitors.field.url} dir="ltr" type="url" value={text('url')} error={errorOf('url')} onChange={event => set('url', event.target.value)} />
        <Input label={t.monitors.field.method} dir="ltr" value={text('method')} placeholder="GET" error={errorOf('method')} onChange={event => set('method', event.target.value)} />
        <Input
          label={t.monitors.field.expectedStatusCodes}
          dir="ltr"
          inputMode="numeric"
          value={row.codesText}
          placeholder="200"
          error={errorOf('expectedStatusCodes')}
          description={t.monitors.hint.expectedStatusCodes}
          onChange={event => onChange(current => ({ ...current, codesText: event.target.value }))}
        />
        <Input
          label={t.monitors.field.maxResponseTime}
          dir="ltr"
          inputMode="numeric"
          value={row.maxText}
          placeholder="5000"
          error={errorOf('maxResponseTime')}
          onChange={event => onChange(current => ({ ...current, maxText: event.target.value }))}
        />
        {(row.monitor.check === 'statuspage' || row.monitor.check === 'incidentio' || text('component') !== '') && (
          <Input label={t.monitors.field.component} value={text('component')} error={errorOf('component')} onChange={event => set('component', event.target.value)} />
        )}
      </div>

      {isRenamed(row) && <p className="text-sm text-kumo-warning" role="note">{t.monitors.slugRenamed(row.savedSlug ?? '')}</p>}
      {hasHiddenSettings(row.monitor) && <p className="text-xs text-kumo-subtle">{t.monitors.keepsOtherSettings}</p>}

      <MonitorActions monitor={buildMonitor(row).monitor} busy={busy} />
    </section>
  )
}

/** Warnings, and errors on a path the editor has no field for. */
function OtherFindings({ t, findings }: { t: Strings, findings: Findings }) {
  if (findings.other.length === 0) {
    return null
  }
  return (
    <section className="space-y-2" aria-labelledby="statusbeam-findings-heading">
      <h2 id="statusbeam-findings-heading" className="text-lg font-medium">{t.monitors.otherFindings}</h2>
      <ul className="list-disc space-y-2 ps-5 text-sm">
        {findings.other.map(issue => (
          <li key={`${issue.severity}:${issue.path}:${issue.message}`} className={issue.severity === 'error' ? 'text-kumo-danger' : 'text-kumo-warning'}>
            {issue.severity === 'warning' && <span className="font-medium">{`${t.monitors.warning}: `}</span>}
            {issue.path !== '' && <bdi dir="ltr" className="font-mono">{`${issue.path}: `}</bdi>}
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Each secret reads "set" or "not set"; the values live on EmDash's generated settings page and are never requested. */
function Secrets({ t, secretsSet }: { t: Strings, secretsSet: SecretsSet }) {
  const labels: Array<[keyof SecretsSet, string]> = [
    ['slackWebhookUrl', t.secrets.slackWebhookUrl],
    ['webhookUrls', t.secrets.webhookUrls],
    ['webhookSecret', t.secrets.webhookSecret],
    ['sentryToken', t.secrets.sentryToken],
  ]
  return (
    <section className="space-y-3 rounded-lg border border-kumo-line p-4" aria-labelledby="statusbeam-secrets-heading">
      <h2 id="statusbeam-secrets-heading" className="text-lg font-medium">{t.secrets.heading}</h2>
      <p className="text-sm text-kumo-subtle">{t.secrets.intro}</p>
      <dl className="space-y-2 text-sm">
        {labels.map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <dt>{label}</dt>
            <dd className={secretsSet[key] ? 'font-medium text-kumo-success' : 'text-kumo-subtle'}>
              {secretsSet[key] ? t.secrets.set : t.secrets.notSet}
            </dd>
          </div>
        ))}
      </dl>
      <a className="text-sm text-kumo-link underline" href={SETTINGS_PAGE_HREF}>{t.secrets.manage}</a>
    </section>
  )
}
