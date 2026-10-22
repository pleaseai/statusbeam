import type { CheckResult, DayCounts, SiteSummary } from '@statusbeam/core'
import type { DayBucket } from '../src/buckets'
import { readFileSync } from 'node:fs'
import { buildSiteSummaries, groupDayStats } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { applyResults, pruneExpiredBuckets, toDayCounts } from '../src/buckets'
import { CALL_BUDGET, fitsBudget, MAX_SHARDS, monitorsPerTask, plannedCalls, SCHEDULER_CLAIM_LIMIT } from '../src/budget'
import { runShard } from '../src/run'
import { MAINTENANCE_TASK, monitorsPerShard, pollableSites, reconcileShards, shardCountFor, shardSites } from '../src/shards'
import { readSnapshot } from '../src/snapshot'
import { createFakeContext, monitorNames, monitorsYaml } from './fake-context'

describe('the call budget model', () => {
  it('fits six monitors per task with no reserved calls, and fewer as calls are reserved', () => {
    expect(CALL_BUDGET).toBe(10)
    expect(monitorsPerTask()).toBe(6)
    expect(monitorsPerTask(2)).toBe(4)
    expect(plannedCalls(6)).toBe(CALL_BUDGET)
    expect(fitsBudget(6)).toBe(true)
    expect(fitsBudget(7)).toBe(false)
    expect(fitsBudget(6, 1)).toBe(false)
  })

  it('keeps the shard cap below the scheduler claim limit', () => {
    expect(MAX_SHARDS).toBeLessThan(SCHEDULER_CLAIM_LIMIT)
  })
})

describe('sharding', () => {
  it('uses ceil(n / 6) shards, capped at MAX_SHARDS', () => {
    expect([0, 1, 6, 7, 12, 13, 48, 49, 500].map(shardCountFor)).toEqual([0, 1, 1, 2, 2, 3, 8, 8, 8])
  })

  it('puts every pollable monitor in exactly one shard, deterministically, in slug order', () => {
    for (const count of [1, 5, 6, 7, 20, 48]) {
      const config = { sites: [...monitorNames(count)].reverse().map(name => ({ name, slug: name, url: `https://${name}.example.com/`, check: 'http', method: 'GET', expectedStatusCodes: [200], maxResponseTime: 5000 })) }
      const sorted = pollableSites(config as never)
      const shards = Array.from({ length: shardCountFor(count) }, (_, i) => shardSites(sorted, i).map(s => s.slug))
      expect(shards.flat()).toEqual(monitorNames(count))
      expect(shards.every(shard => shard.length <= monitorsPerShard())).toBe(true)
    }
  })
})

describe('runShard', () => {
  it('stays within the call budget for a full shard and never logs', async () => {
    const fake = createFakeContext({ config: monitorsYaml(monitorNames(6)) })
    const result = await runShard(fake.ctx, 0)
    expect(result).toEqual({ probed: 6, skipped: 0, calls: CALL_BUDGET })
    expect(fake.bridgeCalls).toHaveLength(CALL_BUDGET)
    expect(fake.bridgeCalls.filter(c => c.startsWith('log.'))).toEqual([])
    expect(fake.bridgeCalls.filter(c => c === 'http.fetch')).toHaveLength(6)
    expect(fake.bridgeCalls.filter(c => c === 'storage.putMany')).toHaveLength(1)
  })

  it('does not start a probe the budget cannot afford', async () => {
    const fake = createFakeContext({ config: monitorsYaml(monitorNames(6)) })
    const result = await runShard(fake.ctx, 0, { reservedCalls: 2 })
    expect(result.probed).toBe(4)
    expect(result.skipped).toBe(2)
    expect(fake.bridgeCalls.filter(c => c === 'http.fetch')).toHaveLength(4)
    expect(fake.bridgeCalls.length + 2).toBeLessThanOrEqual(CALL_BUDGET)
  })

  it('grades a probe that misses the deadline down with code 0 and still probes the others', async () => {
    const fake = createFakeContext({
      config: monitorsYaml(['aaa', 'hang', 'zzz']),
      fetch: url => (url.includes('hang') ? new Promise<Response>(() => {}) : Promise.resolve(new Response('ok', { status: 200 }))),
    })
    const started = Date.now()
    await runShard(fake.ctx, 0, { deadlineMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)

    const snapshot = fake.kv.get('snapshot:0') as { results: CheckResult[] }
    const bySlug = new Map(snapshot.results.map(r => [r.slug, r]))
    expect(bySlug.get('hang')).toMatchObject({ status: 'down', code: 0 })
    expect(bySlug.get('aaa')).toMatchObject({ status: 'up', code: 200 })
    expect(bySlug.get('zzz')).toMatchObject({ status: 'up', code: 200 })
    expect([...fake.rows.values()].map(b => [b.slug, b.down, b.up])).toEqual([['aaa', 0, 1], ['hang', 1, 0], ['zzz', 0, 1]])
  })

  it('checks nothing and writes nothing without a valid configuration', async () => {
    for (const config of [undefined, 'sites: [broken']) {
      const fake = createFakeContext({ config })
      const result = await runShard(fake.ctx, 0)
      expect(result.probed).toBe(0)
      expect(fake.bridgeCalls).toEqual(['settings.get'])
      expect(fake.rows.size + fake.kv.size).toBe(0)
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

  it('deletes buckets before the 90-day window across pages, within its call allowance', async () => {
    const old = Array.from({ length: 130 }, (_, i) => bucket(`2026-05-${String((i % 28) + 1).padStart(2, '0')}`)).map((b, i) => ({ ...b, slug: `s${i}` }))
    const fake = createFakeContext({ buckets: [...old, bucket('2026-07-25'), bucket('2026-10-22')] })
    const result = await pruneExpiredBuckets(fake.ctx, new Date('2026-10-22T12:00:00.000Z'), 4)
    expect(result.deleted).toBe(130)
    expect(result.calls).toBe(4)
    expect([...fake.rows.values()].map(b => b.date).sort()).toEqual(['2026-07-25', '2026-10-22'])
  })
})

describe('reconcileShards', () => {
  it('schedules the shard tasks and the maintenance task, within the call budget', async () => {
    const fake = createFakeContext({ config: monitorsYaml(monitorNames(14)) })
    const result = await reconcileShards(fake.ctx)
    expect([...fake.tasks.keys()].sort()).toEqual(['check-0', 'check-1', 'check-2', MAINTENANCE_TASK])
    expect(fake.tasks.get('check-2')).toMatchObject({ schedule: '*/5 * * * *', data: { shard: 2 } })
    expect(result.deferred).toBe(0)
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
  })

  it('caps the shards at MAX_SHARDS, spends at most the budget, and defers what does not fit', async () => {
    const fake = createFakeContext({ config: monitorsYaml(monitorNames(60)) })
    const result = await reconcileShards(fake.ctx)
    expect(result.shards).toBe(MAX_SHARDS)
    expect(result.uncovered).toBe(60 - MAX_SHARDS * 6)
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect([...fake.tasks.keys()].filter(n => n.startsWith('check-'))).toHaveLength(MAX_SHARDS)
    expect(result.deferred).toBe(1)

    const again = await reconcileShards(createFakeContext({ config: monitorsYaml(monitorNames(60)), tasks: [...fake.tasks.values()] }).ctx)
    expect(again.deferred).toBe(0)
    expect(again.scheduled).toEqual([MAINTENANCE_TASK])
  })

  it('cancels surplus shards when the monitor count drops and leaves them alone for an unusable configuration', async () => {
    const tasks = [0, 1, 2].map(i => ({ name: `check-${i}`, schedule: '*/5 * * * *' }))
    const shrunk = createFakeContext({ config: monitorsYaml(monitorNames(2)), tasks })
    const result = await reconcileShards(shrunk.ctx)
    expect(result.cancelled.sort()).toEqual(['check-1', 'check-2'])

    const broken = createFakeContext({ config: 'sites: [broken', tasks })
    await reconcileShards(broken.ctx)
    expect([...broken.tasks.keys()].sort()).toEqual(['check-0', 'check-1', 'check-2', MAINTENANCE_TASK])
  })
})

describe('readSnapshot', () => {
  it('merges the shard snapshots, with the newest check winning for a monitor in two of them', async () => {
    const fake = createFakeContext()
    const result = (slug: string, status: CheckResult['status'], checkedAt: string): CheckResult => ({ slug, status, code: 200, responseTime: 1, checkedAt })
    fake.kv.set('snapshot:0', { version: 1, shard: 0, updatedAt: '2026-10-22T10:05:00.000Z', results: [result('a', 'up', '2026-10-22T10:05:00.000Z'), result('b', 'down', '2026-10-22T10:00:00.000Z')] })
    fake.kv.set('snapshot:1', { version: 1, shard: 1, updatedAt: '2026-10-22T10:10:00.000Z', results: [result('b', 'up', '2026-10-22T10:10:00.000Z')] })
    fake.kv.set('state:other', { unrelated: true })

    const merged = await readSnapshot(fake.ctx)
    expect([...merged.results].map(([slug, r]) => [slug, r.status])).toEqual([['a', 'up'], ['b', 'up']])
    expect(merged.updatedAt).toBe('2026-10-22T10:10:00.000Z')
  })
})
