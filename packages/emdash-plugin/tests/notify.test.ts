import type { Site } from '@statusbeam/core'
import type { ShardSnapshot } from '../src/snapshot'
import { siteSchema } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { CALL_BUDGET } from '../src/budget'
import { classifyHostError, probeSite } from '../src/probe'
import { runShard } from '../src/run'
import { parseUrlList } from '../src/settings'
import { readSnapshot, summariesFromSnapshot } from '../src/snapshot'
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

  it('collapses a repeated URL and counts, without keeping, an entry that is not a URL', () => {
    expect(parseUrlList(`${HOOK_A}\n${HOOK_A}, not-a-url ftp://x.example.com/`)).toEqual({ urls: [HOOK_A, HOOK_A], invalid: 2 })
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

  it('keeps a monitor that moved between shards on its previous result and history', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b']), fetch: w.fetch })
    await runShard(fake.ctx, 0, { now: c.now })
    // The monitor list grows: `b` now sorts into a different shard than the one that stored it.
    const grown = createFakeContext({ config: monitorsYaml(['a', 'b']), fetch: w.fetch })
    for (const [key, value] of fake.kv) {
      const snapshot = value as ShardSnapshot
      grown.kv.set(key === 'snapshot:0' ? 'snapshot:3' : key, { ...snapshot, shard: 3 })
    }
    for (const [id, bucket] of fake.rows) {
      grown.rows.set(id, bucket)
    }
    w.down.add('b')
    c.set('2026-10-22T10:05:00.000Z')
    await runShard(grown.ctx, 0, { now: c.now })

    const b = (await readSnapshot(grown.ctx)).monitors.get('b')
    expect(b?.result).toMatchObject({ status: 'down' })
    expect(b?.days.at(-1)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
  })
})
