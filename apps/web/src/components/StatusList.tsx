import type { Dict, Locale, SiteSummary } from '@statusbeam/core'
import { formatUptime, getDict, toSeverity, windowUptime } from '@statusbeam/core'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ResponseChart } from './ResponseChart'
import { UptimeTimeline } from './UptimeTimeline'

// Status-token styling per severity; the label text comes from the locale dict.
const STYLE = {
  operational: { dot: 'bg-status-operational', badge: 'border-status-operational/40 text-status-operational' },
  degraded: { dot: 'bg-status-degraded', badge: 'border-status-degraded/40 text-status-degraded' },
  partial_outage: { dot: 'bg-status-partial', badge: 'border-status-partial/40 text-status-partial' },
  major_outage: { dot: 'bg-status-major', badge: 'border-status-major/40 text-status-major' },
  maintenance: { dot: 'bg-status-maintenance', badge: 'border-status-maintenance/40 text-status-maintenance' },
} as const

// A site not checked yet (`pending`) has no real status: neutral styling, its own label.
const PENDING_STYLE = { dot: 'bg-status-nodata', badge: 'border-status-nodata/40 text-muted-foreground' } as const
const NO_UPTIME = '—'

/**
 * One status card row: name + rolled-up badge, a 90-day uptime timeline, and an
 * expandable response-time sparkline. Interactive (the breakdown tooltip and the
 * expand toggle), so it lives in the hydrated island.
 */
function StatusRow({ site, locale, t }: Readonly<{ site: SiteSummary, locale: Locale, t: Dict }>) {
  const [open, setOpen] = useState(false)
  const severity = toSeverity(site.status)
  const style = site.pending ? PENDING_STYLE : STYLE[severity]
  // Guard against stale KV snapshots written before these fields existed.
  const history = site.history ?? []
  const responseHistory = site.responseHistory ?? []
  // A pending site's empty history reads as 100% in every uptime window: show no figure instead, as the uptime badge does.
  const uptime90 = site.pending ? NO_UPTIME : formatUptime(windowUptime(history))
  const breakdown = site.pending
    ? t.breakdown({ day: NO_UPTIME, week: NO_UPTIME, month: NO_UPTIME, quarter: NO_UPTIME })
    : t.breakdown({ day: site.uptimeDay, week: site.uptimeWeek, month: site.uptimeMonth, quarter: uptime90 })
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={cn('inline-block size-2.5 rounded-full', style.dot)} />
          <span className="font-medium">{site.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger
              render={(
                <span
                  tabIndex={0}
                  className="cursor-default rounded-sm text-sm tabular-nums text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              )}
            >
              {uptime90}
            </TooltipTrigger>
            <TooltipContent>{breakdown}</TooltipContent>
          </Tooltip>
          <Badge variant="outline" className={style.badge}>
            {site.pending ? t.status.notChecked : t.severity[severity]}
          </Badge>
        </div>
      </div>
      <div className="mt-3">
        <UptimeTimeline history={history} locale={locale} />
      </div>
      {responseHistory.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            aria-controls={`chart-${site.slug}`}
            className="flex items-center gap-1.5 rounded-sm text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            <span>{t.status.responseTime}</span>
            <span>
              ·
              {' '}
              {site.responseTime}
              {' '}
              {t.unit.ms}
            </span>
          </button>
          {open && (
            <div id={`chart-${site.slug}`} className="mt-2">
              <ResponseChart data={responseHistory} locale={locale} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Per-component status cards. Interactive (uptime tooltips + expandable
 * response-time charts), so it hydrates as a React island.
 */
export function StatusList({ summary, locale }: Readonly<{ summary: SiteSummary[], locale: Locale }>) {
  const t = getDict(locale)
  return (
    <TooltipProvider delay={100}>
      <Card className="gap-0 divide-y divide-border overflow-hidden py-0">
        {summary.map(site => (
          <StatusRow key={site.slug} site={site} locale={locale} t={t} />
        ))}
      </Card>
    </TooltipProvider>
  )
}
