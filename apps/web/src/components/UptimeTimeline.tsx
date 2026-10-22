import type { DayStat, Locale } from '@statusbeam/core'
import { formatDay, formatUptime, getDict, uptimeFigure } from '@statusbeam/core'
import { cn } from '@/lib/utils'

const DAY_COLOR = {
  up: 'bg-status-operational',
  degraded: 'bg-status-degraded',
  down: 'bg-status-major',
  nodata: 'bg-status-nodata',
} as const

/**
 * 90-day uptime bar timeline. Each bar carries a native `title` for per-day
 * detail — cheap and accessible for a dense strip, and it needs no JS, so the
 * timeline renders as static HTML. Bars flex to fill the width and shrink on
 * narrow viewports (adaptive), so the full window fits without a scrollbar.
 */
export function UptimeTimeline({ history, pending, locale }: Readonly<{ history: DayStat[], pending?: boolean, locale: Locale }>) {
  const t = getDict(locale)
  // Named by the same figure the row shows, so the two never disagree.
  const figure = uptimeFigure({ pending, history })
  const label = figure === null ? t.timeline.ariaNoData : t.timeline.ariaUptime(figure)
  return (
    <div>
      <div
        className="flex h-9 items-stretch gap-px"
        role="img"
        aria-label={label}
      >
        {history.map((d) => {
          const key = d.status ?? 'nodata'
          // Only real (non-nodata) days carry an uptime figure in the tooltip.
          const uptimeSuffix = d.status !== null ? ` · ${formatUptime(d.uptime)}` : ''
          return (
            <div
              key={d.date}
              title={`${formatDay(d.date, locale)} — ${t.day[key]}${uptimeSuffix}`}
              className={cn(
                'min-w-[2px] flex-1 rounded-[1px] transition-opacity hover:opacity-70',
                DAY_COLOR[key],
              )}
            />
          )
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{t.timeline.windowStart(90)}</span>
        <span>{t.timeline.today}</span>
      </div>
    </div>
  )
}
