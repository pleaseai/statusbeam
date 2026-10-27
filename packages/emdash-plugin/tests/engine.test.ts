import type { CheckResult, DayCounts, SiteSummary } from '@statusbeam/core'
import type { DayBucket } from '../src/buckets'
import type { PollSnapshot } from '../src/snapshot'
import { readFileSync } from 'node:fs'
import { buildSiteSummaries, groupDayStats, siteSchema } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { applyResults, pruneExpiredBuckets, toDayCounts } from '../src/buckets'
import { pollableSites, runMaintenance } from '../src/run'
import { CHECK_SCHEDULE, CHECK_TASK, MAINTENANCE_SCHEDULE, MAINTENANCE_TASK, reconcileSchedule } from '../src/schedule'
import { POLL_SNAPSHOT_KEY, readSnapshot, summariesFromSnapshot } from '../src/snapshot'
import { createFakeContext, monitorNames, monitorsYaml, runFake } from './fake-context'

describe('pollableSites', () => {
  it('lists every pollable monitor in slug order and leaves out Sentry monitors without a token', () => {
    const sites = [...monitorNames(12)].reverse().map(name => siteSchema.parse({ name, url: `https://${name}.example.com/` }))
    const sentry = siteSchema.parse({ name: 'errors', check: 'sentry', url: 'https://sentry.example.com/', sentry: { org: 'acme' } })
    expect(pollableSites([...sites, sentry]).map(s => s.slug)).toEqual(monitorNames(12))
    expect(pollableSites([...sites, sentry], { sentryToken: 'tok' }).map(s => s.slug)).toEqual(['errors', ...monitorNames(12)].sort())
  })
})

describe('runCheck', () => {
  it('checks all 12 monitors in one run and writes their buckets and one snapshot', async () => {
    const names = monitorNames(12)
    const seen: string[] = []
    const fake = createFakeContext({ config: monitorsYaml(names), fetch: async (url) => {
      seen.push(url)
      return new Response('ok', { status: 200 })
    } })

    const result = await runFake(fake)

    expect(result).toEqual({ probed: 12, deliveries: 0 })
    expect(seen.sort()).toEqual(names.map(n => `https://${n}.example.com/`))
    expect([...fake.rows.values()].map(b => [b.slug, b.up, b.total]).sort()).toEqual(names.map(n => [n, 1, 1]))
    const snapshot = fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot
    expect(snapshot.monitors.map(m => m.slug)).toEqual(names)
    expect(snapshot.monitors.every(m => m.result?.status === 'up' && m.result.code === 200)).toBe(true)
  })

  it('polls a Sentry monitor with the sentryToken secret and skips it without one', async () => {
    const yaml = monitorsYaml(['web'], ['  - name: errors', '    check: sentry', '    url: https://sentry.example.com/', '    sentry:', '      org: acme'])
    const seen: Array<{ url: string, auth: string | null }> = []
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response(new URL(url).hostname === 'sentry.io' ? '[]' : 'ok', { status: 200 })
    }

    await runFake(createFakeContext({ config: yaml, settings: { sentryToken: 'tok' }, fetch }))
    const polled = seen.find(s => s.url.includes('/organizations/acme/'))
    expect(polled?.auth).toBe('Bearer tok')

    seen.length = 0
    await runFake(createFakeContext({ config: yaml, fetch }))
    expect(seen.map(s => s.url)).toEqual(['https://web.example.com/'])
  })

  it('sends body-reading checks through ctx.http and plain checks through the header-only client', async () => {
    const yaml = monitorsYaml(['web'], ['  - name: errors', '    check: sentry', '    url: https://sentry.example.com/', '    sentry:', '      org: acme'])
    const viaCtx: string[] = []
    const viaProbe: string[] = []
    const fake = createFakeContext({ config: yaml, settings: { sentryToken: 'tok' }, fetch: async (url) => {
      viaCtx.push(url)
      return new Response('[]', { status: 200 })
    } })
    await runFake(fake, { probeHttp: { fetch: async (url) => {
      viaProbe.push(String(url))
      return new Response(null, { status: 200 })
    } } })
    expect(viaProbe).toEqual(['https://web.example.com/'])
    expect(viaCtx.every(url => url.includes('sentry'))).toBe(true)
    expect(viaCtx.length).toBeGreaterThan(0)
  })

  it('grades a probe that misses the deadline down with code 0, while the others finish', async () => {
    const fake = createFakeContext({
      config: monitorsYaml(['aaa', 'hang', 'zzz']),
      fetch: url => (url.includes('hang') ? new Promise<Response>(() => {}) : Promise.resolve(new Response('ok', { status: 200 }))),
    })
    const started = Date.now()
    await runFake(fake, { deadlineMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)

    const snapshot = fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot
    const bySlug = new Map(snapshot.monitors.map(m => [m.slug, m.result]))
    expect(bySlug.get('hang')).toMatchObject({ status: 'down', code: 0 })
    expect(bySlug.get('aaa')).toMatchObject({ status: 'up', code: 200 })
    expect(bySlug.get('zzz')).toMatchObject({ status: 'up', code: 200 })
    expect([...fake.rows.values()].map(b => [b.slug, b.down, b.up])).toEqual([['aaa', 0, 1], ['hang', 1, 0], ['zzz', 0, 1]])
  })

  it('does not wait for a hung monitor before finishing the others', async () => {
    const finished: string[] = []
    const fake = createFakeContext({
      config: monitorsYaml(['fast', 'hang']),
      fetch: async (url) => {
        if (url.includes('hang')) {
          return new Promise<Response>(() => {})
        }
        finished.push(url)
        return new Response('ok', { status: 200 })
      },
    })
    const run = runFake(fake, { deadlineMs: 300 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(finished).toEqual(['https://fast.example.com/'])
    await run
  })

  it('does not check a monitor removed from the configuration, and drops it from the snapshot', async () => {
    const seen: string[] = []
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b', 'c']), fetch: async (url) => {
      seen.push(url)
      return new Response('ok', { status: 200 })
    } })
    await runFake(fake)
    seen.length = 0

    fake.setConfig(monitorsYaml(['a', 'c']))
    await runFake(fake)

    expect(seen.sort()).toEqual(['https://a.example.com/', 'https://c.example.com/'])
    expect((fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot).monitors.map(m => m.slug)).toEqual(['a', 'c'])
    expect((await readSnapshot(fake.ctx)).monitors.has('b')).toBe(false)
  })

  it('checks nothing and writes nothing without a valid configuration', async () => {
    // An absent configuration writes nothing; an invalid one writes only the configuration-error record.
    const cases: Array<[string | undefined, string[]]> = [[undefined, []], ['sites: [broken', ['snapshot:config-error']]]
    for (const [config, kvKeys] of cases) {
      const fake = createFakeContext({ config })
      const result = await runFake(fake)
      expect(result.probed).toBe(0)
      expect([...fake.kv.keys()]).toEqual(kvKeys)
      expect(fake.rows.size).toBe(0)
    }
  })
})

describe('buckets against the standalone rollup', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../core/src/fixtures/rollup-worker.json', import.meta.url), 'utf8')) as {
    now: string
    config: { sites: unknown[] }
    dayRows: DayCounts[]
    previous: SiteSummary[]
    results: CheckResult[]
    expectedSummary: SiteSummary[]
  }

  it('reproduces the recorded worker summary from per-check history fed through the bucket accumulator', () => {
    // Expand the recorded per-day counts back into individual checks, then feed them
    // to the accumulator one at a time, the way successive cron runs do.
    const history: CheckResult[] = fixture.dayRows.flatMap(row => [
      ...Array.from({ length: row.up }, () => 'up' as const),
      ...Array.from({ length: row.degraded }, () => 'degraded' as const),
      ...Array.from({ length: row.down }, () => 'down' as const),
    ].map((status, i) => ({ slug: row.slug, status, code: status === 'down' ? 500 : 200, responseTime: 100, checkedAt: `${row.day}T${String(i % 24).padStart(2, '0')}:00:00.000Z` })))

    // The fixture also records one day row with no checks. No run can create an empty
    // bucket, so carry it over as stored, which keeps the comparison exact.
    const stored = new Map<string, DayBucket>(
      fixture.dayRows.filter(row => row.total === 0).map(row => [`${row.slug}:${row.day}`, { slug: row.slug, date: row.day, up: 0, degraded: 0, down: 0, total: 0 }]),
    )
    for (const result of history) {
      for (const { id, data } of applyResults(stored, [result])) {
        stored.set(id, data)
      }
    }

    const summary = buildSiteSummaries({
      sites: fixture.config.sites as never,
      results: fixture.results,
      previous: new Map(fixture.previous.map(s => [s.slug, s])),
      historyBySlug: groupDayStats([...stored.values()].map(toDayCounts)),
      now: new Date(fixture.now),
    })
    expect(JSON.parse(JSON.stringify(summary))).toEqual(fixture.expectedSummary)
  })

  it('gives the same 90-day figures as the standalone rollup for the same results (AC-006)', async () => {
    // 90 days of runs, one every 6 hours, with a deterministic mix of statuses.
    const start = new Date('2026-07-25T00:00:00.000Z')
    const runs = Array.from({ length: 90 * 4 }, (_, i) => new Date(start.getTime() + i * 6 * 3_600_000))
    const statusAt = (i: number) => (i % 11 === 0 ? 500 : 200)
    let current = runs[0] as Date
    let index = 0
    const fake = createFakeContext({ config: monitorsYaml(['a']), fetch: async () => new Response('x', { status: statusAt(index) }) })
    const counts = new Map<string, DayCounts>()
    for (const [i, at] of runs.entries()) {
      index = i
      current = at
      await runFake(fake, { now: () => current })
      const day = at.toISOString().slice(0, 10)
      const row = counts.get(day) ?? { slug: 'a', day, up: 0, degraded: 0, down: 0, total: 0 }
      row[statusAt(i) === 200 ? 'up' : 'down'] += 1
      row.total += 1
      counts.set(day, row)
    }

    const now = new Date(runs.at(-1) as Date)
    const sites = [siteSchema.parse({ name: 'a', url: 'https://a.example.com/' })]
    const fromPlugin = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, now)
    // The standalone worker's path: `GROUP BY slug, date(checked_at)` rows into core's rollup.
    const fromWorker = buildSiteSummaries({
      sites,
      results: [(fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot).monitors[0]?.result as CheckResult],
      previous: new Map(),
      historyBySlug: groupDayStats([...counts.values()]),
      now,
    })
    expect(fromPlugin[0]?.history).toHaveLength(90)
    expect(JSON.parse(JSON.stringify(fromPlugin))).toEqual(JSON.parse(JSON.stringify(fromWorker)))
  })

  it('counts a check on the UTC day of its checkedAt', () => {
    const rows = applyResults(new Map(), [
      { slug: 'a', status: 'up', code: 200, responseTime: 1, checkedAt: '2026-10-21T23:59:59.000Z' },
      { slug: 'a', status: 'down', code: 0, responseTime: 1, checkedAt: '2026-10-22T00:00:00.000Z' },
    ])
    expect(rows.map(r => [r.id, r.data.up, r.data.down])).toEqual([['a:2026-10-21', 1, 0], ['a:2026-10-22', 0, 1]])
  })
})

describe('pruneExpiredBuckets', () => {
  const bucket = (date: string): DayBucket => ({ slug: 'a', date, up: 1, degraded: 0, down: 0, total: 1 })

  it('deletes buckets before the 90-day window across pages', async () => {
    const old = Array.from({ length: 230 }, (_, i) => bucket(`2026-05-${String((i % 28) + 1).padStart(2, '0')}`)).map((b, i) => ({ ...b, slug: `s${i}` }))
    const fake = createFakeContext({ buckets: [...old, bucket('2026-07-25'), bucket('2026-10-22')] })
    const result = await runMaintenance(fake.ctx, { now: () => new Date('2026-10-22T12:00:00.000Z') })
    expect(result.deleted).toBe(230)
    expect([...fake.rows.values()].map(b => b.date).sort()).toEqual(['2026-07-25', '2026-10-22'])
    expect(await pruneExpiredBuckets(fake.ctx, new Date('2026-10-22T12:00:00.000Z'))).toBe(0)
  })
})

describe('reconcileSchedule', () => {
  it('creates the check and maintenance tasks when neither exists', async () => {
    const fake = createFakeContext()
    const result = await reconcileSchedule(fake.ctx)
    expect(result).toEqual({ scheduled: [CHECK_TASK, MAINTENANCE_TASK], cancelled: [] })
    expect(fake.tasks.get(CHECK_TASK)).toMatchObject({ schedule: CHECK_SCHEDULE })
    expect(fake.tasks.get(MAINTENANCE_TASK)).toMatchObject({ schedule: MAINTENANCE_SCHEDULE })
  })

  it('never calls schedule() for a task that is already as wanted, so it cannot starve', async () => {
    const fake = createFakeContext({ tasks: [{ name: CHECK_TASK, schedule: CHECK_SCHEDULE }, { name: MAINTENANCE_TASK, schedule: MAINTENANCE_SCHEDULE }] })
    const result = await reconcileSchedule(fake.ctx)
    expect(result).toEqual({ scheduled: [], cancelled: [] })
    expect(fake.bridgeCalls).toEqual(['cron.list'])
  })

  it('updates a task whose schedule changed and removes a stale one', async () => {
    const fake = createFakeContext({ tasks: [
      { name: CHECK_TASK, schedule: '* * * * *' },
      { name: MAINTENANCE_TASK, schedule: MAINTENANCE_SCHEDULE },
      { name: 'check-0', schedule: CHECK_SCHEDULE },
      { name: 'check-1', schedule: CHECK_SCHEDULE },
    ] })
    const result = await reconcileSchedule(fake.ctx)
    expect(result).toEqual({ scheduled: [CHECK_TASK], cancelled: ['check-0', 'check-1'] })
    expect([...fake.tasks.keys()].sort()).toEqual([CHECK_TASK, MAINTENANCE_TASK])
    expect(fake.tasks.get(CHECK_TASK)?.schedule).toBe(CHECK_SCHEDULE)
  })
})

describe('readSnapshot', () => {
  it('reads the poll snapshot and ignores other entries', async () => {
    const fake = createFakeContext()
    const result = (slug: string, status: CheckResult['status'], checkedAt: string): CheckResult => ({ slug, status, code: 200, responseTime: 1, checkedAt })
    const monitor = (r: CheckResult) => ({ slug: r.slug, result: r, days: [], totals: {} })
    const poll: PollSnapshot = { version: 2, updatedAt: '2026-10-22T10:10:00.000Z', monitors: [monitor(result('a', 'up', '2026-10-22T10:10:00.000Z')), monitor(result('b', 'down', '2026-10-22T10:10:00.000Z'))], deliveries: [] }
    fake.kv.set(POLL_SNAPSHOT_KEY, poll)
    fake.kv.set('snapshot:0', { ...poll, monitors: [monitor(result('stale', 'up', '2026-10-22T09:00:00.000Z'))] })
    fake.kv.set('state:other', { unrelated: true })

    const merged = await readSnapshot(fake.ctx)
    expect([...merged.results].map(([slug, r]) => [slug, r.status])).toEqual([['a', 'up'], ['b', 'down']])
    expect(merged.updatedAt).toBe('2026-10-22T10:10:00.000Z')
    expect(fake.bridgeCalls).toEqual(['kv.list'])
  })
})
