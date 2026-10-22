import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import type { DayBucket } from '../src/buckets'
import type { ShardSnapshot } from '../src/snapshot'
import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { dayStatFromCounts, groupDayStats } from '@statusbeam/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/** An explicit comparator for `sort`, so the order never depends on the engine's default string conversion. */
const byText = (a: string, b: string) => a.localeCompare(b)

/**
 * The plugin reads the real clock inside workerd, where a test cannot freeze it.
 * So each test starts clear of UTC midnight (waiting past it when it is close)
 * and captures one time that the fixtures and the expectations share.
 */
const MIDNIGHT_MARGIN_MS = 20_000

async function clearOfMidnight(): Promise<Date> {
  const now = Date.now()
  const untilMidnight = 86_400_000 - (now % 86_400_000)
  if (untilMidnight < MIDNIGHT_MARGIN_MS) {
    await new Promise(resolve => setTimeout(resolve, untilMidnight + 100))
  }
  return new Date()
}

let testStart = new Date()

beforeEach(async () => {
  testStart = await clearOfMidnight()
})

const today = () => testStart.toISOString().slice(0, 10)
const daysAgo = (days: number) => new Date(testStart.getTime() - days * 86_400_000).toISOString().slice(0, 10)

function cron(name: string, data: Record<string, unknown> = {}) {
  return { name, data, scheduledAt: testStart.toISOString() }
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
    for (const name of names.slice(0, 5)) {
      await h.http.respond(`https://${name}.example.com/`, new Response('ok', { status: 200 }))
    }

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))

    expect(h.http.requests().map(r => r.url).sort(byText)).toEqual(names.slice(0, 5).map(n => `https://${n}.example.com/`))
    expect(h.http.requests().every(r => r.method === 'GET')).toBe(true)

    const rows = await bucketRows(h)
    expect(rows.map(r => r.slug).sort(byText)).toEqual(names.slice(0, 5))
    expect(rows.every(r => r.date === today() && r.up === 1 && r.total === 1)).toBe(true)

    const snapshot = await h.inspect.kv.get<ShardSnapshot>('snapshot:0')
    expect(snapshot?.monitors.map(m => m.slug).sort(byText)).toEqual(names.slice(0, 5))
    expect(snapshot?.monitors.every(m => m.result?.status === 'up' && m.result.code === 200)).toBe(true)
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
    expect(probed.sort(byText)).toEqual(names.map(n => `https://${n}.example.com/`))
    expect(new Set(probed).size).toBe(names.length)
    expect((await bucketRows(h)).map(r => r.slug).sort(byText)).toEqual(names)
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
    // Only the configuration-error record (T008) is written.
    expect(await h.inspect.kv.list()).toHaveLength(1)
    expect(await h.inspect.kv.get('snapshot:config-error')).toMatchObject({ version: 1, issues: [{ severity: 'error', path: '' }] })
    await h.dispose()

    // No configuration setting at all: nothing is wrong, so not even the error record is written.
    host = await createPluginRuntimeTestHost()
    await host.transport.invokeHook('cron', cron('check-0', { shard: 0 }))
    expect(host.http.requests()).toEqual([])
    expect(await bucketRows(host)).toEqual([])
    expect(await host.inspect.kv.list()).toEqual([])
  })
})

describe('notifications through the runtime host', () => {
  it('reads the encrypted secret settings and posts a status change to them', async () => {
    const h = await newHost(config(['m01']))
    await h.fixtures.plugin.setting('slackWebhookUrl', 'https://hooks.example.com/services/SECRET')
    await h.http.respond('https://m01.example.com/', new Response('ok', { status: 200 }))
    await h.http.respond('https://hooks.example.com/services/SECRET', new Response('ok', { status: 200 }))

    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))
    await h.http.respond('https://m01.example.com/', new Response('boom', { status: 500 }))
    await h.transport.invokeHook('cron', cron('check-0', { shard: 0 }))

    const posts = h.http.requests().filter(r => r.method === 'POST')
    expect(posts.map(r => r.url)).toEqual(['https://hooks.example.com/services/SECRET'])
    const snapshot = await h.inspect.kv.get<ShardSnapshot>('snapshot:0')
    expect(snapshot?.deliveries).toEqual([{ kind: 'slack', target: 'hooks.example.com/…', ok: true, status: 200 }])
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
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

    expect((await bucketRows(h)).map(r => r.date).sort(byText)).toEqual([daysAgo(89), daysAgo(0)].sort(byText))
  })
})

describe('shard reconciliation on activate', () => {
  it('schedules ceil(n / 5) shard tasks on the 5-minute cadence, plus the maintenance task', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const h = await newHost(config(names))

    await h.actions.plugin.activate()

    const tasks = await h.inspect.scheduledTasks()
    const byName = new Map(tasks.map(t => [t.name as string, t]))
    expect([...byName.keys()].sort(byText)).toEqual(['check-0', 'check-1', 'check-2', 'maintenance'])
    expect(byName.get('check-1')?.schedule).toBe('*/5 * * * *')
  })

  it('cancels surplus shard tasks when the configuration shrinks', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const h = await newHost(config(many))
    await h.actions.plugin.activate()

    await h.fixtures.plugin.setting('config', config(['m00', 'm01']))
    await h.transport.invokeHook('plugin:activate', {})

    const names = (await h.inspect.scheduledTasks()).map(t => t.name as string).sort(byText)
    expect(names).toEqual(['check-0', 'maintenance'])
  })
})
