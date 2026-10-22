import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import type { DayBucket } from '../src/buckets'
import type { ShardSnapshot } from '../src/snapshot'
import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { dayStatFromCounts, groupDayStats } from '@statusbeam/core'
import { afterEach, describe, expect, it } from 'vitest'
import { toDayCounts } from '../src/buckets'

/**
 * These tests drive the built plugin through EmDash's production sandbox wrapper
 * (Worker Loader inside workerd) with `host.http.respond` standing in for the
 * monitored endpoints. Neither test host reproduces deployed subrequest limits,
 * so call counts are asserted in `budget.test.ts` against a counting context.
 */

let host: PluginRuntimeTestHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

function config(sites: string[], extra = ''): string {
  return [
    'name: Test',
    'sites:',
    ...sites.flatMap(name => [`  - name: ${name}`, `    url: https://${name}.example.com/`, ...(extra ? [extra] : [])]),
  ].join('\n')
}

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

function cron(name: string, data: Record<string, unknown> = {}) {
  return { name, data, scheduledAt: new Date().toISOString() }
}

async function newHost(yaml: string): Promise<PluginRuntimeTestHost> {
  host = await createPluginRuntimeTestHost()
  await host.fixtures.plugin.setting('config', yaml)
  return host
}

async function bucketRows(h: PluginRuntimeTestHost): Promise<DayBucket[]> {
  return (await h.inspect.storage.list<DayBucket>('buckets')).map(entry => entry.data)
}

describe('a shard cron task', () => {
  const names = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08']

  it('probes exactly its shard monitors through ctx.http.fetch and writes buckets plus its own snapshot', async () => {
    const h = await newHost(config(names))
    for (const name of names.slice(0, 6)) {
      await h.http.respond(`https://${name}.example.com/`, new Response('ok', { status: 200 }))
    }

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))

    expect(h.http.requests().map(r => r.url).sort()).toEqual(names.slice(0, 6).map(n => `https://${n}.example.com/`))
    expect(h.http.requests().every(r => r.method === 'GET')).toBe(true)

    const rows = await bucketRows(h)
    expect(rows.map(r => r.slug).sort()).toEqual(names.slice(0, 6))
    expect(rows.every(r => r.date === today() && r.up === 1 && r.total === 1)).toBe(true)

    const snapshot = await h.inspect.kv.get<ShardSnapshot>('snapshot:0')
    expect(snapshot?.results.map(r => r.slug).sort()).toEqual(names.slice(0, 6))
    expect(snapshot?.results.every(r => r.status === 'up' && r.code === 200)).toBe(true)
    expect(await h.inspect.kv.get('snapshot:1')).toBeNull()
  })

  it('covers every monitor in exactly one of the shards', async () => {
    const h = await newHost(config(names))
    for (const name of names) {
      await h.http.respond(`https://${name}.example.com/`, new Response('ok', { status: 200 }))
    }

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))
    await h.transport.invokeHook('cron', cron('check-1', { shard: 1 }))

    const probed = h.http.requests().map(r => r.url)
    expect(probed.sort()).toEqual(names.map(n => `https://${n}.example.com/`))
    expect(new Set(probed).size).toBe(names.length)
    expect((await bucketRows(h)).map(r => r.slug).sort()).toEqual(names)
  })

  it('adds to the existing day bucket and derives the same day stat as the standalone rollup', async () => {
    const h = await newHost(config(['m01']))
    await h.fixtures.plugin.storage('buckets', `m01:${today()}`, { slug: 'm01', date: today(), up: 3, degraded: 1, down: 0, total: 4 })
    await h.http.respond('https://m01.example.com/', new Response('boom', { status: 500 }))

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))

    const [bucket] = await bucketRows(h)
    expect(bucket).toMatchObject({ up: 3, degraded: 1, down: 1, total: 5 })
    const stats = groupDayStats(bucket ? [toDayCounts(bucket)] : []).get('m01')?.get(today())
    expect(stats).toEqual(dayStatFromCounts({ day: today(), up: 3, degraded: 1, down: 1, total: 5 }))
    expect(stats?.status).toBe('down')
    expect(stats?.uptime).toBeCloseTo(3 / 5)
  })

  it('does not poll a webhook-only Sentry monitor', async () => {
    const yaml = [
      'name: Test',
      'sites:',
      '  - name: web',
      '    url: https://web.example.com/',
      '  - name: errors',
      '    check: sentry',
      '    url: https://sentry.example.com/',
    ].join('\n')
    const h = await newHost(yaml)
    await h.http.respond('https://web.example.com/', new Response('ok', { status: 200 }))

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))

    expect(h.http.requests().map(r => r.url)).toEqual(['https://web.example.com/'])
    expect((await bucketRows(h)).map(r => r.slug)).toEqual(['web'])
  })

  it('checks nothing and writes nothing for an invalid or absent configuration', async () => {
    const h = await newHost('name: Test\nsites: [oops')
    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))
    expect(h.http.requests()).toEqual([])
    expect(await bucketRows(h)).toEqual([])
    expect(await h.inspect.kv.list()).toEqual([])
  })
})

describe('the maintenance cron task', () => {
  it('prunes buckets older than 90 days and keeps those inside the window', async () => {
    const h = await newHost(config(['m01']))
    const seed = (age: number) => h.fixtures.plugin.storage('buckets', `m01:${daysAgo(age)}`, { slug: 'm01', date: daysAgo(age), up: 1, degraded: 0, down: 0, total: 1 })
    await seed(120)
    await seed(91)
    await seed(89)
    await seed(0)

    await h.transport.invokeHook('cron', cron('maintenance'))

    expect((await bucketRows(h)).map(r => r.date).sort()).toEqual([daysAgo(89), daysAgo(0)].sort())
  })
})

describe('shard reconciliation on activate', () => {
  it('schedules ceil(n / 6) shard tasks on the 5-minute cadence, plus the maintenance task', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const h = await newHost(config(names))

    await h.actions.plugin.activate()

    const tasks = await h.inspect.scheduledTasks()
    const byName = new Map(tasks.map(t => [t.name as string, t]))
    expect([...byName.keys()].sort()).toEqual(['check-0', 'check-1', 'check-2', 'maintenance'])
    expect(byName.get('check-1')?.schedule).toBe('*/5 * * * *')
  })

  it('cancels surplus shard tasks when the configuration shrinks', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const h = await newHost(config(many))
    await h.actions.plugin.activate()

    await h.fixtures.plugin.setting('config', config(['m00', 'm01']))
    await h.transport.invokeHook('plugin:activate', {})

    const names = (await h.inspect.scheduledTasks()).map(t => t.name as string).sort()
    expect(names).toEqual(['check-0', 'maintenance'])
  })
})
