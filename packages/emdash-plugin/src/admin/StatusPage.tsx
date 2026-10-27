import type { CheckStatus, DayStat, SiteSummary } from '@statusbeam/core'
import { Banner } from '@cloudflare/kumo'
import { formatDay, formatUptime, getDict, uptimeFigure } from '@statusbeam/core'
import { AdminGate } from './AdminGate'
import { MONITORS_PAGE_HREF } from './api'
import { useAdminLocale } from './i18n'
import { useOverview } from './useOverview'

/** The status overview page: every monitor with its status, 90 days of history and latest latency (FR-8). */
export function StatusPage() {
  return (
    <AdminGate>
      <StatusOverview />
    </AdminGate>
  )
}

const DAY_BAR_CLASS = {
  up: 'h-9 bg-kumo-success',
  degraded: 'h-7 bg-kumo-warning',
  down: 'h-5 bg-kumo-danger',
  nodata: 'h-3 bg-kumo-fill',
} as const

const STATUS_TEXT_CLASS: Record<CheckStatus, string> = {
  up: 'text-kumo-success',
  degraded: 'text-kumo-warning',
  down: 'text-kumo-danger',
}

function StatusOverview() {
  const locale = useAdminLocale()
  const dict = getDict(locale)
  const t = dict.admin
  const state = useOverview()

  if (state.kind === 'failed') {
    return <div className="p-6"><Banner variant="error" description={state.message} role="alert" /></div>
  }
  if (state.kind === 'loading') {
    return <p className="p-6 text-sm text-kumo-subtle" role="status">{t.loading}</p>
  }
  const { overview } = state
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.overview.title}</h1>
        <a className="text-sm text-kumo-link underline" href={MONITORS_PAGE_HREF}>{t.overview.manage}</a>
      </div>
      {!overview.configured && overview.configIssues.length > 0 && (
        <section className="space-y-2" aria-labelledby="statusbeam-config-issues">
          <h2 id="statusbeam-config-issues" className="text-lg font-medium">{t.overview.configIssues}</h2>
          <ul className="list-disc space-y-2 ps-5 text-sm text-kumo-danger">
            {overview.configIssues.map(issue => (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.path !== '' && <bdi dir="ltr" className="font-mono">{`${issue.path}: `}</bdi>}
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {overview.monitors.length === 0
        ? <p className="text-sm text-kumo-subtle">{t.overview.empty}</p>
        : (
            <>
              <p className="text-lg font-medium" role="status">{dict.banner[overview.status]}</p>
              <ul className="space-y-4" role="list">
                {overview.monitors.map(monitor => (
                  <li key={monitor.slug}><MonitorCard monitor={monitor} /></li>
                ))}
              </ul>
            </>
          )}
    </div>
  )
}

function MonitorCard({ monitor }: { monitor: SiteSummary }) {
  const locale = useAdminLocale()
  const dict = getDict(locale)
  const figure = uptimeFigure(monitor)
  const headingId = `statusbeam-monitor-${monitor.slug}`
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border bg-kumo-base p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-medium">{monitor.name}</h2>
        <p className={`font-medium ${monitor.pending ? 'text-kumo-subtle' : STATUS_TEXT_CLASS[monitor.status]}`}>
          {monitor.pending ? dict.status.notChecked : dict.day[monitor.status]}
        </p>
      </div>
      {!monitor.pending && (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt className="text-kumo-subtle">{dict.status.responseTime}</dt>
            <dd>{`${monitor.responseTime} ${dict.unit.ms}`}</dd>
          </div>
          {figure !== null && (
            <div className="flex gap-1">
              <dt className="text-kumo-subtle">{dict.admin.overview.uptime}</dt>
              <dd>{figure}</dd>
            </div>
          )}
        </dl>
      )}
      <DayBars history={monitor.history} figure={monitor.pending ? null : figure} />
    </section>
  )
}

/**
 * The 90-day strip: one bar per day. Colour and height both follow the day's
 * status, and each bar carries the day, its status and its uptime as text (a
 * `title` and visually hidden text), so no day is conveyed by colour alone.
 */
function DayBars({ history, figure }: { history: DayStat[], figure: string | null }) {
  const locale = useAdminLocale()
  const dict = getDict(locale)
  const label = figure === null ? dict.timeline.ariaNoData : dict.timeline.ariaUptime(figure)
  return (
    <div className="space-y-1">
      <ul className="flex items-end gap-px" role="list" aria-label={label}>
        {history.map((day) => {
          const key = day.status ?? 'nodata'
          const text = `${formatDay(day.date, locale)} — ${dict.day[key]}${day.status !== null ? ` · ${formatUptime(day.uptime)}` : ''}`
          return (
            <li key={day.date} className={`min-w-0 flex-1 rounded-sm ${DAY_BAR_CLASS[key]}`} title={text} data-day={key}>
              <span className="sr-only">{text}</span>
            </li>
          )
        })}
      </ul>
      <div className="flex justify-between text-xs text-kumo-subtle">
        <span>{dict.timeline.windowStart(90)}</span>
        <span>{dict.timeline.today}</span>
      </div>
    </div>
  )
}
