import type { Site } from '@statusbeam/core'
import type { ShardSnapshot } from '../src/snapshot'
import { siteSchema } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { CALL_BUDGET } from '../src/budget'
import { classifyHostError, probeSite } from '../src/probe'
import { runShard } from '../src/run'
import { destinationsFrom, parseUrlList } from '../src/settings'
import { handoffFor, mergeSnapshots, readSnapshot, summariesFromSnapshot } from '../src/snapshot'
import { createFakeContext, monitorNames, monitorsYaml } from './fake-context'

const BODY_LIMIT = 'Plugin HTTP response body exceeds the 8388608 byte limit'
const SLACK = 'https://hooks.slack.com/services/T000/B000/SLACKSECRET'
const HOOK_A = 'https://example.org/hook?token=HOOKSECRETA'
const HOOK_B = 'https://other.example.net/h/HOOKSECRETB'

/** Monitors are `https://<slug>.example.com/`; the fake fetch decides each answer by slug. */
function world() {
  const requests: Array<{ url: string, method: string, body?: unknown }> = []
  const down = new Set<string>()
  const overLimit = new Set<string>()
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ url, method, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) })
    if (method === 'POST') {
      return new Response('ok', { status: 200 })
    }
    const slug = new URL(url).hostname.split('.')[0] as string
    if (overLimit.has(slug)) {
      throw new Error(BODY_LIMIT)
    }
    return new Response('x', { status: down.has(slug) ? 500 : 200 })
  }
  const posts = () => requests.filter(r => r.method === 'POST')
  return { requests, down, overLimit, fetch, posts }
}

function clock(start = '2026-10-22T10:00:00.000Z') {
  let current = new Date(start)
  return { now: () => current, set: (iso: string) => void (current = new Date(iso)) }
}

const SECRETS = {
  slack: { slackWebhookUrl: SLACK },
  both: { slackWebhookUrl: SLACK, webhookUrls: `${HOOK_A}\n${HOOK_B}` },
  hook: { webhookUrls: HOOK_A },
}

describe('the host body-limit classifier', () => {
  const site: Site = siteSchema.parse({ name: 'Big', url: 'https://big.example.com/' })

  it('recognises the recorded rejection text in every execution mode and nothing else', async () => {
    expect(classifyHostError(new Error(BODY_LIMIT))).toBe('body')
    expect(classifyHostError(new Error(`Bridge call http/fetch failed: {"error":"${BODY_LIMIT}"}`))).toBe('body')
    expect(classifyHostError(new Error('Plugin "x": blocked fetch to "y": Hostname resolved to no addresses'))).toBeUndefined()
    expect(classifyHostError(new Error('probe exceeded the 10000 ms deadline'))).toBeUndefined()
  })

  it('makes probeSite return limit "body" for the rejection, and a plain down for another failure', async () => {
    const limited = await probeSite(() => Promise.reject(new Error(BODY_LIMIT)), site)
    expect(limited).toMatchObject({ status: 'down', code: 0, limit: 'body' })
    const refused = await probeSite(() => Promise.reject(new Error('connection refused')), site)
    expect(refused.limit).toBeUndefined()
  })

  it('never hands the host fetch an AbortSignal, for a sentry poll or an aigateway monitor', async () => {
    const sentry = siteSchema.parse({ name: 'Errors', url: 'https://errors.example.com/', check: 'sentry', sentry: { org: 'acme' } })
    const gateway = siteSchema.parse({ name: 'Model', check: 'aigateway', aigateway: { provider: 'vercel', model: 'anthropic/claude-opus-4.5' } })
    const inits: Array<RequestInit | undefined> = []
    const hostFetch = async (_url: string, init?: RequestInit) => {
      inits.push(init)
      return new Response('[]', { status: 200 })
    }
    await probeSite(hostFetch, sentry, 1000, undefined, 'tok')
    await probeSite(hostFetch, gateway, 1000)
    expect(inits).toHaveLength(2)
    for (const init of inits) {
      expect(init).toBeDefined()
      expect('signal' in (init as RequestInit)).toBe(false)
      expect(init?.method).toBe('GET')
    }
  })
})

describe('a body-limit failure', () => {
  it('marks the monitor unsupported: no bucket, no status change, no notification, a persistent warning', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['big', 'ok']), settings: SECRETS.both, fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    expect(fake.rows.size).toBe(2)

    w.overLimit.add('big')
    c.set('2026-10-22T10:05:00.000Z')
    const result = await runShard(fake.ctx, 0, { now: c.now })

    expect(result.unsupported).toBe(1)
    expect(fake.rows.get('big:2026-10-22')).toMatchObject({ up: 1, down: 0, total: 1 })
    expect(fake.rows.get('ok:2026-10-22')).toMatchObject({ up: 2, total: 2 })
    expect(w.posts()).toEqual([])

    const merged = await readSnapshot(fake.ctx)
    expect(merged.results.get('big')).toMatchObject({ status: 'up', code: 200 })
    expect(merged.monitors.get('big')?.warning).toEqual({ limit: 'body', since: '2026-10-22T10:05:00.000Z', lastSeen: '2026-10-22T10:05:00.000Z' })
    expect(merged.monitors.get('ok')?.warning).toBeUndefined()
    const day = merged.monitors.get('big')?.days.at(-1)
    expect(day).toEqual({ date: '2026-10-22', status: 'up', uptime: 1 })
  })

  it('keeps the warning with its first time while the limit persists, then clears it when a probe completes', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['big']), fetch: w.fetch })
    w.overLimit.add('big')
    await runShard(fake.ctx, 0, { now: c.now })
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })

    const first = (await readSnapshot(fake.ctx)).monitors.get('big')
    expect(first?.warning).toEqual({ limit: 'body', since: '2026-10-22T10:00:00.000Z', lastSeen: '2026-10-22T10:05:00.000Z' })
    expect(first?.result).toBeNull()
    expect(fake.rows.size).toBe(0)

    w.overLimit.delete('big')
    c.set('2026-10-22T10:10:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    const recovered = (await readSnapshot(fake.ctx)).monitors.get('big')
    expect(recovered?.warning).toBeUndefined()
    expect(recovered?.result).toMatchObject({ status: 'up' })
    expect(fake.rows.get('big:2026-10-22')).toMatchObject({ up: 1, total: 1 })
  })

  it('leaves a monitor whose only probes hit the limit out of the public summaries, and reads an unprobed one as not checked yet', async () => {
    const at = '2026-10-22T10:05:00.000Z'
    const warning = { limit: 'body' as const, since: at, lastSeen: at }
    const snapshot: ShardSnapshot = {
      version: 2,
      shard: 0,
      updatedAt: at,
      deliveries: [],
      monitors: [
        { slug: 'big', result: null, days: [], totals: {}, warning },
        { slug: 'old', result: { slug: 'old', status: 'up', code: 200, responseTime: 40, checkedAt: '2026-10-22T10:00:00.000Z' }, days: [], totals: {}, warning },
      ],
    }
    const sites = ['big', 'old', 'new'].map(name => siteSchema.parse({ name, url: `https://${name}.example.com/` }))
    const summaries = summariesFromSnapshot(mergeSnapshots([{ key: 'snapshot:0', value: snapshot }]), sites, new Date(at))
    expect(summaries.map(s => [s.slug, s.status, s.pending])).toEqual([['old', 'up', undefined], ['new', 'down', true]])
  })

  it('does not compare a limit result for change detection, so a recovery to the same status sends nothing', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['big']), settings: SECRETS.slack, fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    w.overLimit.add('big')
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    w.overLimit.delete('big')
    c.set('2026-10-22T10:10:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    expect(w.posts()).toEqual([])
  })

  it('leaves the uptime in the summaries as the real checks made it', async () => {
    const w = world()
    const c = clock()
    const yaml = monitorsYaml(['big'])
    const fake = createFakeContext({ config: yaml, fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    const sites = [siteSchema.parse({ name: 'big', url: 'https://big.example.com/' })]
    const before = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())

    w.overLimit.add('big')
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    const after = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())

    expect(after[0]?.status).toBe('up')
    expect(after[0]?.uptimeDay).toBe(before[0]?.uptimeDay)
    expect(after[0]?.history.at(-1)).toEqual(before[0]?.history.at(-1))
  })

  it('never retries a GET monitor as HEAD', async () => {
    const w = world()
    w.overLimit.add('big')
    const fake = createFakeContext({ config: monitorsYaml(['big']), fetch: w.fetch })
    await runShard(fake.ctx, 0)
    expect(w.requests.map(r => [r.method, r.url])).toEqual([['GET', 'https://big.example.com/']])
  })
})

describe('status-change notifications', () => {
  it('posts one message per destination carrying every change of the run, to the secret URLs', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b']), settings: SECRETS.both, fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    expect(w.posts()).toEqual([])

    w.down.add('a')
    w.down.add('b')
    c.set('2026-10-22T10:05:00.000Z')
    const result = await runShard(fake.ctx, 0, { now: c.now })

    expect(result.deliveries).toBe(3)
    expect(w.posts().map(r => r.url).sort()).toEqual([HOOK_A, HOOK_B, SLACK].sort())
    const slack = w.posts().find(r => r.url === SLACK)?.body as { text: string }
    expect(slack.text).toContain('*a*: up → down')
    expect(slack.text).toContain('*b*: up → down')
    const hook = w.posts().find(r => r.url === HOOK_A)?.body as { changes: Array<{ slug: string, from: string, to: string }>, severity: string }
    expect(hook.changes).toEqual([{ slug: 'a', from: 'up', to: 'down' }, { slug: 'b', from: 'up', to: 'down' }])
    expect(hook.severity).toBe('major_outage')
  })

  it('sends nothing for a monitor\'s first real result after it read as not checked yet', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['a']), settings: SECRETS.both, fetch: w.fetch })
    const sites = [siteSchema.parse({ name: 'a', url: 'https://a.example.com/' })]
    expect(summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())[0]).toMatchObject({ status: 'down', pending: true })

    w.down.add('a')
    await runShard(fake.ctx, 0, { now: c.now })

    expect(w.posts()).toEqual([])
    const [after] = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())
    expect(after).toMatchObject({ status: 'down' })
    expect(after).not.toHaveProperty('pending')
  })

  it('sends nothing when nothing changed or no destination is configured', async () => {
    const w = world()
    const c = clock()
    const withHooks = createFakeContext({ config: monitorsYaml(['a']), settings: SECRETS.hook, fetch: w.fetch })
    await runShard(withHooks.ctx, 0, { now: c.now })
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(withHooks.ctx, 0, { now: c.now })
    expect(w.posts()).toEqual([])

    const none = createFakeContext({ config: monitorsYaml(['a']), fetch: w.fetch })
    await runShard(none.ctx, 0, { now: c.now })
    w.down.add('a')
    await runShard(none.ctx, 0, { now: c.now })
    expect(w.posts()).toEqual([])
  })

  it('stores outcomes with a redacted host and never a full URL, even when a delivery fails', async () => {
    const w = world()
    const c = clock()
    const failing = async (url: string, init?: RequestInit) => {
      if (url === HOOK_A) {
        throw new Error(`blocked fetch to "${url}"`)
      }
      return w.fetch(url, init)
    }
    const fake = createFakeContext({ config: monitorsYaml(['a']), settings: SECRETS.both, fetch: failing })
    await runShard(fake.ctx, 0, { now: c.now })
    w.down.add('a')
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })

    const snapshot = fake.kv.get('snapshot:0') as ShardSnapshot
    expect(snapshot.deliveries).toEqual([
      { kind: 'slack', target: 'hooks.slack.com/…', ok: true, status: 200 },
      { kind: 'webhook', target: 'example.org/…', ok: false, error: 'error' },
      { kind: 'webhook', target: 'other.example.net/…', ok: true, status: 200 },
    ])
    const stored = JSON.stringify([...fake.kv.values(), ...fake.rows.values()])
    for (const secret of ['SLACKSECRET', 'HOOKSECRETA', 'HOOKSECRETB', 'token=']) {
      expect(stored).not.toContain(secret)
    }
    expect(fake.bridgeCalls.filter(call => call.startsWith('log.'))).toEqual([])
  })

  it('collapses a repeated URL into one destination, across both secret settings too', () => {
    const repeated = destinationsFrom(new Map([['webhookUrls', `${HOOK_A}\n${HOOK_A}`]]))
    expect(repeated).toEqual({ destinations: [{ kind: 'webhook', url: HOOK_A }], invalid: 0 })
    const across = destinationsFrom(new Map([['slackWebhookUrl', SLACK], ['webhookUrls', `${SLACK}\n${HOOK_A}`]]))
    expect(across.destinations).toEqual([{ kind: 'slack', url: SLACK }, { kind: 'webhook', url: HOOK_A }])
  })

  it('counts, without keeping, an entry that is not a URL', () => {
    expect(parseUrlList(`${HOOK_A}, not-a-url ftp://x.example.com/`)).toEqual({ urls: [HOOK_A], invalid: 2 })
    expect(destinationsFrom(new Map([['webhookUrls', `${HOOK_A} not-a-url`], ['slackWebhookUrl', `nope ${SLACK}`]]))).toEqual({
      destinations: [{ kind: 'slack', url: SLACK }, { kind: 'webhook', url: HOOK_A }],
      invalid: 2,
    })
  })
})

describe('the per-task call budget', () => {
  it('plans every call before the first probe and never exceeds it, for 0, 1 and 2 destinations with full shards', async () => {
    for (const [destinations, settings] of [[0, {}], [1, SECRETS.hook], [2, { slackWebhookUrl: SLACK, webhookUrls: HOOK_A }]] as const) {
      const perTask = 5 - destinations
      const w = world()
      const c = clock()
      const fake = createFakeContext({ config: monitorsYaml(monitorNames(perTask + 3)), settings, fetch: w.fetch })

      const quiet = await runShard(fake.ctx, 0, { now: c.now })
      expect(quiet.probed).toBe(perTask)
      expect(quiet.planned).toBe(CALL_BUDGET)

      for (const name of monitorNames(perTask)) {
        w.down.add(name)
      }
      c.set('2026-10-22T10:05:00.000Z')
      fake.bridgeCalls.length = 0
      const loud = await runShard(fake.ctx, 0, { now: c.now })
      expect(loud.deliveries).toBe(destinations)
      expect(loud.calls).toBe(fake.bridgeCalls.length)
      expect(loud.calls).toBeLessThanOrEqual(loud.planned)
      expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
      expect(fake.bridgeCalls.filter(call => call === 'http.fetch')).toHaveLength(perTask + destinations)
    }
  })

  it('probes nothing and records a capacity error when the destinations leave no call for a probe', async () => {
    const w = world()
    const hooks = Array.from({ length: 4 }, (_, i) => `https://example.org/h${i}`).join(' ')
    const fake = createFakeContext({ config: monitorsYaml(['a']), settings: { slackWebhookUrl: SLACK, webhookUrls: hooks }, fetch: w.fetch })
    const result = await runShard(fake.ctx, 0)
    expect(result.probed).toBe(0)
    expect(w.requests).toEqual([])
    expect(fake.bridgeCalls).toEqual(['settings.list', 'kv.set'])
    expect((await readSnapshot(fake.ctx)).capacityErrors).toHaveLength(1)
  })

  it('stops reporting a capacity error once a shard runs normally, including one left by a shard the configuration no longer has', async () => {
    const shard = (n: number, updatedAt: string, capacityError?: string): ShardSnapshot => ({ version: 2, shard: n, updatedAt, monitors: [], deliveries: [], ...(capacityError ? { capacityError } : {}) })
    const obsolete = { key: 'snapshot:3', value: shard(3, '2026-10-22T09:00:00.000Z', '9 destinations leave no call') }
    const current = { key: 'snapshot:0', value: shard(0, '2026-10-22T10:00:00.000Z', '5 destinations leave no call') }
    expect(mergeSnapshots([obsolete, current]).capacityErrors).toEqual(['5 destinations leave no call'])
    const fixed = { key: 'snapshot:0', value: shard(0, '2026-10-22T10:05:00.000Z') }
    expect(mergeSnapshots([obsolete, fixed]).capacityErrors).toEqual([])
  })
})

describe('a task the runtime ends early', () => {
  it('leaves buckets and snapshot unchanged when it dies before its writes, and tells the destination again on the next run', async () => {
    for (const label of ['storage.getMany', 'kv.list', 'storage.putMany']) {
      const w = world()
      const c = clock()
      let killing = false
      const fake = createFakeContext({
        config: monitorsYaml(['a', 'b']),
        settings: SECRETS.slack,
        fetch: w.fetch,
        failOn: call => killing && call === label,
      })
      await runShard(fake.ctx, 0, { now: c.now })
      const rowsBefore = JSON.stringify([...fake.rows])
      const kvBefore = JSON.stringify([...fake.kv])

      w.down.add('a')
      c.set('2026-10-22T10:05:00.000Z')
      killing = true
      await expect(runShard(fake.ctx, 0, { now: c.now })).rejects.toThrow('runtime ended the task')
      expect(JSON.stringify([...fake.rows])).toBe(rowsBefore)
      expect(JSON.stringify([...fake.kv])).toBe(kvBefore)

      killing = false
      c.set('2026-10-22T10:10:00.000Z')
      await runShard(fake.ctx, 0, { now: c.now })
      expect(w.posts().filter(r => r.url === SLACK).length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('the snapshot history', () => {
  it('derives today from the bucket counts and shifts the window when the day rolls over', async () => {
    const w = world()
    const c = clock('2026-10-22T23:55:00.000Z')
    const fake = createFakeContext({ config: monitorsYaml(['a']), fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    w.down.add('a')
    c.set('2026-10-22T23:58:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    c.set('2026-10-23T00:03:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })

    const days = (await readSnapshot(fake.ctx)).monitors.get('a')?.days ?? []
    expect(days).toHaveLength(90)
    expect(days.at(-2)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
    expect(days.at(-1)).toEqual({ date: '2026-10-23', status: 'down', uptime: 0 })
    expect(days[0]?.date).toBe('2026-07-26')
    expect(days.at(-3)).toEqual({ date: '2026-10-21', status: null, uptime: 1 })
  })
})

describe('a configuration change that moves a monitor between shards', () => {
  it('keeps its history and previous result when the old shard runs first, and delivers its status change from the new one', async () => {
    const w = world()
    const c = clock('2026-10-21T10:00:00.000Z')
    // One destination leaves four monitors per shard: `echo` is the last of shard 0.
    const before = ['beta', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const fake = createFakeContext({ config: monitorsYaml(before), settings: SECRETS.slack, fetch: w.fetch })
    const runs: Array<{ calls: number, planned: number }> = []
    const run = async (shard: number) => runs.push(await runShard(fake.ctx, shard, { now: c.now }))
    await run(0)
    await run(1)
    c.set('2026-10-22T10:00:00.000Z')
    await run(0)
    await run(1)
    expect((fake.kv.get('snapshot:0') as ShardSnapshot).monitors.map(m => m.slug)).toContain('echo')

    // `alpha` sorts first, so `echo` moves to shard 1; it also goes down in the same window.
    fake.setConfig(monitorsYaml(['alpha', ...before]))
    w.down.add('echo')
    c.set('2026-10-22T10:05:00.000Z')
    await run(0)
    const old = fake.kv.get('snapshot:0') as ShardSnapshot
    expect(old.monitors.map(m => m.slug)).toEqual(['alpha', 'beta', 'charlie', 'delta'])
    expect(old.handoff?.map(m => m.slug)).toEqual(['echo'])

    // Between the two runs the public summary still shows the monitor and its history.
    const sites = ['alpha', ...before].map(name => siteSchema.parse({ name, url: `https://${name}.example.com/` }))
    const between = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now()).find(s => s.slug === 'echo')
    expect(between?.status).toBe('up')
    expect(between?.history.filter(day => day.status !== null).map(day => day.date)).toEqual(['2026-10-21', '2026-10-22'])

    c.set('2026-10-22T10:10:00.000Z')
    await run(1)
    const echo = (fake.kv.get('snapshot:1') as ShardSnapshot).monitors.find(m => m.slug === 'echo')
    expect(echo?.result).toMatchObject({ status: 'down' })
    expect(echo?.days.at(-2)).toEqual({ date: '2026-10-21', status: 'up', uptime: 1 })
    expect(echo?.days.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
    const slack = w.posts().map(post => (post.body as { text: string }).text)
    expect(slack).toHaveLength(1)
    expect(slack[0]).toContain('*echo*: up → down')

    // The new owner has written it, so the old shard stops carrying it.
    c.set('2026-10-22T10:15:00.000Z')
    await run(0)
    expect((fake.kv.get('snapshot:0') as ShardSnapshot).handoff).toBeUndefined()
    expect((await readSnapshot(fake.ctx)).monitors.get('echo')?.result).toMatchObject({ status: 'down' })

    for (const result of runs) {
      expect(result.calls).toBeLessThanOrEqual(result.planned)
      expect(result.calls).toBeLessThanOrEqual(CALL_BUDGET)
    }
  })

  it('also keeps them when the new shard runs first, and then the old shard carries nothing', async () => {
    const w = world()
    const c = clock('2026-10-21T10:00:00.000Z')
    const before = ['beta', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const fake = createFakeContext({ config: monitorsYaml(before), settings: SECRETS.slack, fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    await runShard(fake.ctx, 1, { now: c.now })

    fake.setConfig(monitorsYaml(['alpha', ...before]))
    w.down.add('echo')
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(fake.ctx, 1, { now: c.now })
    const echo = (fake.kv.get('snapshot:1') as ShardSnapshot).monitors.find(m => m.slug === 'echo')
    expect(echo?.days.at(-2)).toEqual({ date: '2026-10-21', status: 'up', uptime: 1 })
    expect(w.posts().map(post => (post.body as { text: string }).text)).toEqual([expect.stringContaining('*echo*: up → down')])

    c.set('2026-10-22T10:10:00.000Z')
    await runShard(fake.ctx, 0, { now: c.now })
    expect((fake.kv.get('snapshot:0') as ShardSnapshot).handoff).toBeUndefined()
    expect((await readSnapshot(fake.ctx)).monitors.get('echo')?.result).toMatchObject({ status: 'down' })
  })

  it('lets the real owner win over a handoff, whatever their updatedAt order', () => {
    const state = (slug: string, status: 'up' | 'down', checkedAt: string) => ({ slug, result: { slug, status, code: 200, responseTime: 1, checkedAt }, days: [], totals: {} })
    const handoff: ShardSnapshot = { version: 2, shard: 0, updatedAt: '2026-10-22T10:20:00.000Z', monitors: [], handoff: [state('echo', 'up', '2026-10-22T10:00:00.000Z')], deliveries: [] }
    const owner: ShardSnapshot = { version: 2, shard: 1, updatedAt: '2026-10-22T10:10:00.000Z', monitors: [state('echo', 'down', '2026-10-22T10:10:00.000Z')], deliveries: [] }
    const merged = mergeSnapshots([{ key: 'snapshot:0', value: handoff }, { key: 'snapshot:1', value: owner }])
    expect(merged.polled.get('echo')?.result).toMatchObject({ status: 'down' })
    expect(merged.results.get('echo')).toMatchObject({ status: 'down' })
  })

  it('keeps the latest state when two moves in a row leave two shards carrying the monitor', () => {
    const state = (slug: string, status: 'up' | 'down', checkedAt: string) => ({ slug, result: { slug, status, code: 200, responseTime: 1, checkedAt }, days: [], totals: {} })
    // `echo` moved from shard 0 to shard 1, which ran and saw it go down, then on to shard 2 before shard 2 ran.
    const first: ShardSnapshot = { version: 2, shard: 0, updatedAt: '2026-10-22T10:05:00.000Z', monitors: [], handoff: [state('echo', 'up', '2026-10-22T10:00:00.000Z')], deliveries: [] }
    const second: ShardSnapshot = { version: 2, shard: 1, updatedAt: '2026-10-22T10:15:00.000Z', monitors: [], handoff: [state('echo', 'down', '2026-10-22T10:10:00.000Z')], deliveries: [] }
    const entries = [{ key: 'snapshot:0', value: first }, { key: 'snapshot:1', value: second }]
    expect(handoffFor(entries, 0, new Set(), new Set(['echo']))).toEqual([])
    expect(handoffFor(entries, 1, new Set(), new Set(['echo'])).map(m => m.result?.status)).toEqual(['down'])
    // Even before shard 0 drops its copy, and with shard 0 written last, readers take the later result.
    const rewritten = { ...first, updatedAt: '2026-10-22T10:20:00.000Z' }
    expect(mergeSnapshots([{ key: 'snapshot:0', value: rewritten }, { key: 'snapshot:1', value: second }]).polled.get('echo')?.result).toMatchObject({ status: 'down' })
  })
})
