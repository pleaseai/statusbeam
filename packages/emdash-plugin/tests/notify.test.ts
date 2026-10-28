import type { PollSnapshot } from '../src/snapshot'
import { siteSchema } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { classifyHostError, probeSite } from '../src/probe'
import { destinationsFrom, parseUrlList } from '../src/settings'
import { POLL_SNAPSHOT_KEY, readSnapshot, summariesFromSnapshot } from '../src/snapshot'
import { createFakeContext, monitorsYaml, runFake } from './fake-context'

const SLACK = 'https://hooks.slack.com/services/T000/B000/SLACKSECRET'
const HOOK_A = 'https://example.org/hook?token=HOOKSECRETA'
const HOOK_B = 'https://other.example.net/h/HOOKSECRETB'

/** Monitors are `https://<slug>.example.com/`; the fake fetch decides each answer by slug. */
function world() {
  const requests: Array<{ url: string, method: string, body?: unknown }> = []
  const down = new Set<string>()
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ url, method, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) })
    if (method === 'POST') {
      return new Response('ok', { status: 200 })
    }
    const slug = new URL(url).hostname.split('.')[0] as string
    return new Response('x', { status: down.has(slug) ? 500 : 200 })
  }
  const posts = () => requests.filter(r => r.method === 'POST')
  return { requests, down, fetch, posts }
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

describe('status-change notifications', () => {
  it('posts one message per destination carrying every change of the run, to the secret URLs', async () => {
    const w = world()
    const c = clock()
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b']), settings: SECRETS.both, fetch: w.fetch })
    await runFake(fake, { now: c.now })
    expect(w.posts()).toEqual([])

    w.down.add('a')
    w.down.add('b')
    c.set('2026-10-22T10:05:00.000Z')
    const result = await runFake(fake, { now: c.now })

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
    await runFake(fake, { now: c.now })

    expect(w.posts()).toEqual([])
    const [after] = summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())
    expect(after).toMatchObject({ status: 'down' })
    expect(after).not.toHaveProperty('pending')
  })

  it('sends nothing when nothing changed or no destination is configured', async () => {
    const w = world()
    const c = clock()
    const withHooks = createFakeContext({ config: monitorsYaml(['a']), settings: SECRETS.hook, fetch: w.fetch })
    await runFake(withHooks, { now: c.now })
    c.set('2026-10-22T10:05:00.000Z')
    await runFake(withHooks, { now: c.now })
    expect(w.posts()).toEqual([])

    const none = createFakeContext({ config: monitorsYaml(['a']), fetch: w.fetch })
    await runFake(none, { now: c.now })
    w.down.add('a')
    await runFake(none, { now: c.now })
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
    await runFake(fake, { now: c.now })
    w.down.add('a')
    c.set('2026-10-22T10:05:00.000Z')
    await runFake(fake, { now: c.now })

    const snapshot = fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot
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

  it('records a delivery that misses the deadline as a deadline error, and still finishes the others', async () => {
    const w = world()
    const c = clock()
    const hanging = async (url: string, init?: RequestInit) => (url === HOOK_A ? new Promise<Response>(() => {}) : w.fetch(url, init))
    const fake = createFakeContext({ config: monitorsYaml(['a']), settings: SECRETS.both, fetch: hanging })
    await runFake(fake, { now: c.now, deadlineMs: 50 })
    w.down.add('a')
    c.set('2026-10-22T10:05:00.000Z')
    await runFake(fake, { now: c.now, deadlineMs: 50 })

    const snapshot = fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot
    expect(snapshot.deliveries.map(d => [d.target, d.ok, d.error])).toEqual([
      ['hooks.slack.com/…', true, undefined],
      ['example.org/…', false, 'deadline'],
      ['other.example.net/…', true, undefined],
    ])
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
      await runFake(fake, { now: c.now })
      const rowsBefore = JSON.stringify([...fake.rows])
      const kvBefore = JSON.stringify([...fake.kv])

      w.down.add('a')
      c.set('2026-10-22T10:05:00.000Z')
      killing = true
      await expect(runFake(fake, { now: c.now })).rejects.toThrow('runtime ended the task')
      expect(JSON.stringify([...fake.rows])).toBe(rowsBefore)
      expect(JSON.stringify([...fake.kv])).toBe(kvBefore)

      killing = false
      c.set('2026-10-22T10:10:00.000Z')
      await runFake(fake, { now: c.now })
      expect(w.posts().filter(r => r.url === SLACK).length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('the snapshot history', () => {
  it('derives today from the bucket counts and shifts the window when the day rolls over', async () => {
    const w = world()
    const c = clock('2026-10-22T23:55:00.000Z')
    const fake = createFakeContext({ config: monitorsYaml(['a']), fetch: w.fetch })
    await runFake(fake, { now: c.now })
    w.down.add('a')
    c.set('2026-10-22T23:58:00.000Z')
    await runFake(fake, { now: c.now })
    c.set('2026-10-23T00:03:00.000Z')
    await runFake(fake, { now: c.now })

    const days = (await readSnapshot(fake.ctx)).monitors.get('a')?.days ?? []
    expect(days).toHaveLength(90)
    expect(days.at(-2)).toEqual({ date: '2026-10-22', status: 'down', uptime: 0.5 })
    expect(days.at(-1)).toEqual({ date: '2026-10-23', status: 'down', uptime: 0 })
    expect(days[0]?.date).toBe('2026-07-26')
    expect(days.at(-3)).toEqual({ date: '2026-10-21', status: null, uptime: 1 })
  })
})

describe('host body limit', () => {
  const BODY_LIMIT = 'Plugin HTTP response body exceeds the 8388608 byte limit'

  it('recognises the host rejection text in both forms and nothing else', () => {
    expect(classifyHostError(new Error(BODY_LIMIT))).toBe('body')
    expect(classifyHostError(new Error(`Bridge call http/fetch failed: {"error":"${BODY_LIMIT}"}`))).toBe('body')
    expect(classifyHostError(new Error('connection refused'))).toBeUndefined()
  })

  it('tags the probe result with limit "body" only for the host cap', async () => {
    const site = siteSchema.parse({ name: 'Big', url: 'https://big.example.com/' })
    expect(await probeSite(() => Promise.reject(new Error(BODY_LIMIT)), site)).toMatchObject({ status: 'down', code: 0, limit: 'body' })
    expect((await probeSite(() => Promise.reject(new Error('connection refused')), site)).limit).toBeUndefined()
  })

  it('counts nothing, notifies nobody and keeps the previous state for an over-cap body-reading check', async () => {
    const yaml = monitorsYaml([], ['  - name: board', '    check: statuspage', '    url: https://board.example.com/api/v2/summary.json'])
    const posts: string[] = []
    let overCap = false
    const fetch = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url)
        return new Response('ok', { status: 200 })
      }
      if (overCap) {
        throw new Error(BODY_LIMIT)
      }
      return new Response(JSON.stringify({ status: { indicator: 'none' }, components: [] }), { status: 200 })
    }
    const fake = createFakeContext({ config: yaml, settings: SECRETS.slack, fetch })
    const c = clock()
    await runFake(fake, { now: c.now })
    const before = fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot
    const countsBefore = [...fake.rows.values()].map(b => [b.up, b.down, b.total])
    expect(before.monitors[0]?.result?.status).toBe('up')

    overCap = true
    c.set('2026-10-22T10:05:00.000Z')
    await runFake(fake, { now: c.now })

    expect(posts).toEqual([])
    expect([...fake.rows.values()].map(b => [b.up, b.down, b.total])).toEqual(countsBefore)
    expect((fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot).monitors).toEqual(before.monitors)
  })

  it('records nothing and reads as not checked yet for a body-reading check that hits the cap on its first probe', async () => {
    const yaml = monitorsYaml([], ['  - name: board', '    check: statuspage', '    url: https://board.example.com/api/v2/summary.json'])
    const posts: string[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url)
        return new Response('ok', { status: 200 })
      }
      throw new Error(BODY_LIMIT)
    }
    const fake = createFakeContext({ config: yaml, settings: SECRETS.slack, fetch })
    const c = clock()
    await runFake(fake, { now: c.now })

    expect(posts).toEqual([])
    expect([...fake.rows.values()]).toEqual([])
    expect((fake.kv.get(POLL_SNAPSHOT_KEY) as PollSnapshot).monitors).toEqual([])
    const sites = [siteSchema.parse({ name: 'board', url: 'https://board.example.com/', check: 'statuspage' })]
    expect(summariesFromSnapshot(await readSnapshot(fake.ctx), sites, c.now())[0]).toMatchObject({ pending: true })
  })
})
