import type { PollSnapshot } from '../src/snapshot'
import type { Internet } from './host-harness'
import { describe, expect, it } from 'bun:test'
import { createNativePlugin, CRON_HOOK_TIMEOUT_MS } from '../src/native'
import { CHECK_TASK, MAINTENANCE_TASK } from '../src/schedule'
import { bodyText, HOOK, monitors, newHost, SLACK, url } from './host-harness'

const names12 = Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`)
const ok: Internet = () => new Response('ok', { status: 200 })
const resultOf = (snapshot: PollSnapshot | null, slug: string) => snapshot?.monitors.find(m => m.slug === slug)?.result

describe('the native check task on the EmDash runtime', () => {
  it('has a cron hook that outlasts the probe deadline', async () => {
    expect(CRON_HOOK_TIMEOUT_MS).toBeGreaterThan(10_000)
    const plugin = createNativePlugin()
    expect(plugin.hooks.cron?.timeout).toBe(CRON_HOOK_TIMEOUT_MS)
  })

  it('checks all 12 monitors in one run', async () => {
    const requested: string[] = []
    const host = await newHost((target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    await host.setConfig(monitors(names12))

    expect(await host.cron(CHECK_TASK)).toBe(true)

    expect(requested.sort()).toEqual(names12.map(url))
    const snapshot = await host.snapshot()
    expect(snapshot?.monitors.map(m => m.slug)).toEqual(names12)
    expect(snapshot?.monitors.every(m => m.result?.status === 'up' && m.result.code === 200)).toBe(true)
    expect((await host.buckets()).map(b => [b.slug, b.up, b.total]).sort()).toEqual(names12.map(n => [n, 1, 1]))
  })

  it('times a slow body to the headers, and grades a body over 8 MiB by its status code', async () => {
    const host = await newHost((target) => {
      if (target.endsWith('/slow')) {
        // Headers at once; a body that arrives after 3 s, if the reader waited.
        return new Response(new ReadableStream({
          start(controller) {
            setTimeout(() => {
              try {
                controller.close()
              }
              catch {
                // The reader cancelled the body once it had the headers; closing a cancelled stream throws.
              }
            }, 3000).unref?.()
          },
        }), { status: 200 })
      }
      return new Response(new Uint8Array(9 * 1024 * 1024), { status: 200 })
    })
    await host.setConfig(monitors(['slow', 'big']))

    const started = Date.now()
    await host.cron(CHECK_TASK)

    expect(Date.now() - started).toBeLessThan(2500)
    const snapshot = await host.snapshot()
    expect(resultOf(snapshot, 'slow')).toMatchObject({ status: 'up', code: 200 })
    expect(resultOf(snapshot, 'slow')?.responseTime).toBeLessThan(1000)
    expect(resultOf(snapshot, 'big')).toMatchObject({ status: 'up', code: 200 })
  })

  it('grades a hung response down at the deadline while the rest finish', async () => {
    const finished: string[] = []
    const host = await newHost((target) => {
      if (target.endsWith('/hang')) {
        return new Promise<Response>(() => {})
      }
      finished.push(target)
      return new Response('ok', { status: 200 })
    }, { deadlineMs: 400 })
    await host.setConfig(monitors(['aaa', 'hang', 'zzz']))

    const run = host.cron(CHECK_TASK)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(finished.sort()).toEqual([url('aaa'), url('zzz')])
    await run

    const snapshot = await host.snapshot()
    expect(resultOf(snapshot, 'hang')).toMatchObject({ status: 'down', code: 0 })
    expect(resultOf(snapshot, 'aaa')).toMatchObject({ status: 'up', code: 200 })
    expect(resultOf(snapshot, 'zzz')).toMatchObject({ status: 'up', code: 200 })
  })

  it('refuses a private address, also behind a redirect', async () => {
    const reached: string[] = []
    const host = await newHost((target) => {
      reached.push(target)
      if (target.endsWith('/bounce')) {
        return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      return new Response('ok', { status: 200 })
    })
    await host.setConfig(['name: Test', 'sites:', '  - name: loopback', '    url: http://127.0.0.1/', '  - name: metadata', '    url: http://169.254.169.254/latest/meta-data/', '  - name: bounce', `    url: ${url('bounce')}`].join('\n'))

    await host.cron(CHECK_TASK)

    const snapshot = await host.snapshot()
    for (const slug of ['loopback', 'metadata', 'bounce']) {
      expect(resultOf(snapshot, slug)).toMatchObject({ status: 'down', code: 0 })
      expect(resultOf(snapshot, slug)?.error).toContain('non-public IP address')
    }
    // The redirecting URL was fetched once; neither private address was ever requested.
    expect(reached).toEqual([url('bounce')])
  })

  it('does not check a monitor removed from the configuration on the next run', async () => {
    const requested: string[] = []
    const host = await newHost((target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    await host.setConfig(monitors(['a', 'b', 'c']))
    await host.cron(CHECK_TASK)
    requested.length = 0

    await host.setConfig(monitors(['a', 'c']))
    await host.cron(CHECK_TASK)

    expect(requested.sort()).toEqual([url('a'), url('c')])
    expect((await host.snapshot())?.monitors.map(m => m.slug)).toEqual(['a', 'c'])
  })

  it('sends one Slack and one generic webhook message on a status change, and none when unchanged', async () => {
    const posts: Array<{ url: string, body: unknown }> = []
    let status = 200
    const host = await newHost(async (target, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: target, body: JSON.parse(await bodyText(init.body)) })
        return new Response('ok', { status: 200 })
      }
      return new Response('x', { status })
    })
    await host.setConfig(monitors(['api']))
    await host.setSecrets({ slackWebhookUrl: SLACK, webhookUrls: HOOK })

    await host.cron(CHECK_TASK)
    await host.cron(CHECK_TASK)
    expect(posts).toEqual([])

    status = 500
    await host.cron(CHECK_TASK)
    expect(posts.map(p => p.url).sort()).toEqual([HOOK, SLACK])
    expect((posts.find(p => p.url === SLACK)?.body as { text: string }).text).toContain('*api*: up → down')
    expect((posts.find(p => p.url === HOOK)?.body as { changes: unknown[] }).changes).toEqual([{ slug: 'api', from: 'up', to: 'down' }])

    posts.length = 0
    await host.cron(CHECK_TASK)
    expect(posts).toEqual([])
    const snapshot = await host.snapshot()
    expect(snapshot?.deliveries).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('SLACKSECRET')
  })
})

describe('the schedule on the EmDash runtime', () => {
  it('creates the check and maintenance tasks when the plugin first activates, and leaves them untouched on every run', async () => {
    const host = await newHost(ok)
    const before = await host.tasks()
    expect(before.map(t => [t.name, t.schedule]).sort()).toEqual([[CHECK_TASK, '*/5 * * * *'], [MAINTENANCE_TASK, '17 3 * * *']])

    await host.cron(CHECK_TASK)
    await host.cron(MAINTENANCE_TASK)
    // `schedule()` would move `nextRunAt`; an unchanged value shows the run did not call it.
    expect(await host.tasks()).toEqual(before)
  })
})
