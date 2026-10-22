import type { DayCounts } from './rollup'
import type { CheckResult, SiteSummary } from './types'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { buildSiteSummaries, dayStatFromCounts, denseHistory, detectStatusChanges, groupDayStats, HISTORY_DAYS, historyWindowStart } from './rollup'

// Recorded from the pre-refactor worker (`ingest` with a fake D1/KV at a fixed
// `now`): the day-count rows D1 returned, the prior snapshot, the check results,
// and the summary written to KV. Kept as JSON so it stays a verbatim capture.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/rollup-worker.json', import.meta.url), 'utf8')) as {
  now: string
  config: { sites: unknown[] }
  dayRows: DayCounts[]
  previous: SiteSummary[]
  results: CheckResult[]
  expectedSummary: SiteSummary[]
}

describe('rollup against the recorded worker output', () => {
  it('reproduces the summary the worker wrote for the fixed history and now', () => {
    const now = new Date(fixture.now)
    const previous = new Map(fixture.previous.map(s => [s.slug, s]))
    const summary = buildSiteSummaries({
      sites: fixture.config.sites as never,
      results: fixture.results,
      previous,
      historyBySlug: groupDayStats(fixture.dayRows),
      now,
    })
    // Round-trip through JSON, as the worker stores it in KV.
    expect(JSON.parse(JSON.stringify(summary))).toEqual(fixture.expectedSummary)
  })
})

describe('dayStatFromCounts', () => {
  const base = { day: '2026-10-21', up: 0, degraded: 0, down: 0, total: 0 }

  it('grades down over degraded over up', () => {
    expect(dayStatFromCounts({ ...base, up: 7, degraded: 1, down: 2, total: 10 }).status).toBe('down')
    expect(dayStatFromCounts({ ...base, up: 9, degraded: 1, total: 10 }).status).toBe('degraded')
    expect(dayStatFromCounts({ ...base, up: 10, total: 10 }).status).toBe('up')
  })

  it('computes uptime as up / total, or 1 for an empty day', () => {
    expect(dayStatFromCounts({ ...base, up: 3, down: 1, total: 4 })).toEqual({ date: '2026-10-21', status: 'down', uptime: 0.75 })
    expect(dayStatFromCounts(base).uptime).toBe(1)
  })
})

describe('window helpers', () => {
  const now = new Date('2026-10-22T12:34:56.000Z')

  it('starts the window at UTC midnight 89 days before today', () => {
    expect(historyWindowStart(now).toISOString()).toBe('2026-07-25T00:00:00.000Z')
  })

  it('densifies to 90 entries ending today, filling gaps with no-data days', () => {
    const rows: DayCounts[] = [{ slug: 'a', day: '2026-10-22', up: 1, degraded: 0, down: 0, total: 1 }]
    const dense = denseHistory(groupDayStats(rows).get('a'), now)
    expect(dense).toHaveLength(HISTORY_DAYS)
    expect(dense[0]).toEqual({ date: '2026-07-25', status: null, uptime: 1 })
    expect(dense.at(-1)).toEqual({ date: '2026-10-22', status: 'up', uptime: 1 })
  })
})

describe('detectStatusChanges', () => {
  const result = (slug: string, status: CheckResult['status']): CheckResult => ({ slug, status, code: 200, responseTime: 1, checkedAt: '' })

  it('reports only sites whose status moved against the prior snapshot', () => {
    const previous = new Map([['a', { status: 'up' as const }], ['b', { status: 'down' as const }]])
    expect(detectStatusChanges([result('a', 'down'), result('b', 'down')], previous)).toEqual([{ slug: 'a', from: 'up', to: 'down' }])
  })

  it('treats a site with no prior snapshot as unchanged', () => {
    expect(detectStatusChanges([result('new', 'down')], new Map())).toEqual([])
  })

  it('does not report the first real result after a pending summary as a change', () => {
    const previous = new Map([['a', { status: 'down' as const, pending: true }]])
    expect(detectStatusChanges([result('a', 'up')], previous)).toEqual([])
  })
})

describe('buildSiteSummaries pending state', () => {
  const now = new Date('2026-10-22T12:00:00Z')
  const sites = [{ name: 'A', slug: 'a' }, { name: 'B', slug: 'b' }] as never
  const build = (results: CheckResult[], previous: SiteSummary[]) => buildSiteSummaries({
    sites,
    results,
    previous: new Map(previous.map(s => [s.slug, s])),
    historyBySlug: new Map(),
    now,
  })
  const up: CheckResult = { slug: 'a', status: 'up', code: 200, responseTime: 42, checkedAt: now.toISOString() }

  it('marks a site with no result and no previous summary pending, with the placeholder down', () => {
    const [, b] = build([up], [])
    expect(b).toMatchObject({ slug: 'b', status: 'down', pending: true, responseTime: 0 })
  })

  it('keeps a pending site pending until a real result arrives, then clears it', () => {
    const first = build([up], [])
    const second = build([up], first)
    expect(second[1]?.pending).toBe(true)
    const third = build([{ ...up, slug: 'b', status: 'degraded' }], second)
    expect(third[1]).toMatchObject({ slug: 'b', status: 'degraded' })
    expect(third[1]).not.toHaveProperty('pending')
  })

  it('omits the key for a checked site, so its serialized summary is unchanged', () => {
    const [a] = build([up], [])
    expect(JSON.stringify(a)).not.toContain('pending')
  })

  it('keeps a site with a non-pending previous summary on that status', () => {
    const prior: SiteSummary = { slug: 'b', name: 'B', status: 'up', responseTime: 9, uptimeDay: '100%', uptimeWeek: '100%', uptimeMonth: '100%', history: [] }
    const [, b] = build([up], [prior])
    expect(b).toMatchObject({ slug: 'b', status: 'up', responseTime: 9 })
    expect(b).not.toHaveProperty('pending')
  })
})
