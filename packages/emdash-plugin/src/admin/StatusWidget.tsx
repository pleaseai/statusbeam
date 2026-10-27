import type { SiteSummary } from '@statusbeam/core'
import { Banner } from '@cloudflare/kumo'
import { getDict } from '@statusbeam/core'
import { AdminGate } from './AdminGate'
import { OVERVIEW_PAGE_HREF } from './api'
import { useAdminLocale } from './i18n'
import { useOverview } from './useOverview'

/** The dashboard widget: the overall status in one line, with counts, linking to the overview page (FR-10). */
export function StatusWidget() {
  return (
    <AdminGate>
      <Summary />
    </AdminGate>
  )
}

function count(monitors: SiteSummary[], status: SiteSummary['status']): number {
  return monitors.filter(monitor => !monitor.pending && monitor.status === status).length
}

function Summary() {
  const dict = getDict(useAdminLocale())
  const t = dict.admin
  const state = useOverview()

  if (state.kind === 'failed') {
    return <div className="p-4"><Banner variant="error" description={state.message} role="alert" /></div>
  }
  if (state.kind === 'loading') {
    return <p className="p-4 text-sm text-kumo-subtle" role="status">{t.loading}</p>
  }
  const { overview } = state
  const parts: string[] = []
  const pending = overview.monitors.filter(monitor => monitor.pending).length
  for (const key of ['up', 'degraded', 'down'] as const) {
    const n = count(overview.monitors, key)
    if (n > 0) {
      parts.push(`${n} ${dict.day[key]}`)
    }
  }
  if (pending > 0) {
    parts.push(`${pending} ${dict.status.notChecked}`)
  }
  return (
    <div className="space-y-2 p-4">
      {overview.monitors.length === 0
        ? <p className="text-sm text-kumo-subtle">{t.overview.empty}</p>
        : (
            <>
              <p className="text-lg font-medium" role="status">{dict.banner[overview.status]}</p>
              <p className="text-sm text-kumo-subtle">{parts.join(' · ')}</p>
            </>
          )}
      <a className="text-sm text-kumo-link underline" href={OVERVIEW_PAGE_HREF}>{t.overview.view}</a>
    </div>
  )
}
