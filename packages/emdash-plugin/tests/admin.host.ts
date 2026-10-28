import type { PollSnapshot } from '../src/snapshot'
import type { DispatchInit, Host, Internet } from './host-harness'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { stringify } from 'yaml'
import { CONFIG_ERROR_KEY } from '../src/config'
import { ADMIN_ROUTE, MAX_YAML_BYTES } from '../src/routes/admin'
import { CHECK_TASK, MAINTENANCE_TASK } from '../src/schedule'
import { ADMIN, CSRF_HEADER, EDITOR, HOOK, HOST, newHost, SLACK, url } from './host-harness'

/**
 * The admin-only routes through `dispatchPluginApiRequest`, the host's own
 * authentication, permission and CSRF boundary, on a real `EmDashRuntime`.
 */

const SECRETS = {
  slackWebhookUrl: SLACK,
  webhookUrls: HOOK,
  webhookSecret: 'wh-secret-VALUE-1234',
  sentryToken: 'sentry-token-VALUE-5678',
}
const SECRET_VALUES = ['SLACKSECRET', 'HOOKSECRET', 'wh-secret-VALUE-1234', 'sentry-token-VALUE-5678']

const ok: Internet = () => new Response('ok', { status: 200 })

const doc = (names: string[]) => ({ name: 'Test', sites: names.map(name => ({ name, url: url(name) })) })
const yamlOf = (config: unknown) => stringify(config, { lineWidth: 0 })

/** Every response body of a test, so no test can leak a secret unnoticed. */
let seen: string[] = []
beforeEach(() => {
  seen = []
})
afterEach(() => {
  for (const body of seen) {
    for (const secret of SECRET_VALUES) {
      expect(body).not.toContain(secret)
    }
  }
})

interface Reply<T = Record<string, any>> {
  status: number
  data: T
  error?: { code: string, message: string }
}

async function send<T = Record<string, any>>(host: Host, route: string, init: DispatchInit = {}): Promise<Reply<T>> {
  const response = await host.dispatch(route, init)
  const text = await response.text()
  seen.push(text)
  const parsed = JSON.parse(text) as { data?: T, error?: { code: string, message: string } }
  return { status: response.status, data: parsed.data as T, ...(parsed.error ? { error: parsed.error } : {}) }
}

/** An administrator's call, as the admin UI makes it. */
const asAdmin = (init: DispatchInit = {}): DispatchInit => ({ user: ADMIN, headers: CSRF_HEADER, ...init })
const post = (body: unknown, init: DispatchInit = {}): DispatchInit => asAdmin({ method: 'POST', body: JSON.stringify(body), ...init })

const getConfig = (host: Host) => send(host, ADMIN_ROUTE.config, asAdmin())
const validate = (host: Host, config: unknown) => send(host, ADMIN_ROUTE.validate, post({ config }))
const save = (host: Host, config: unknown, revision: string | null) => send(host, ADMIN_ROUTE.save, post({ config, revision }))
const testMonitor = (host: Host, body: unknown) => send(host, ADMIN_ROUTE.test, post(body))
const overview = (host: Host) => send(host, ADMIN_ROUTE.overview, asAdmin())

async function configuredHost(config: unknown, internet: Internet = ok, deps = {}) {
  const host = await newHost(internet, deps)
  await host.setConfig(yamlOf(config))
  await host.setSecrets(SECRETS)
  return host
}

/** The plugin's writable state, to prove a route did not touch it. */
async function state(host: Host) {
  return { kv: (await host.kvKeys()).sort(), buckets: await host.bucketRows(), tasks: await host.tasks() }
}

const ROUTES: Array<{ name: string, route: string, init: DispatchInit }> = [
  { name: 'config', route: ADMIN_ROUTE.config, init: {} },
  { name: 'validate', route: ADMIN_ROUTE.validate, init: { method: 'POST', body: JSON.stringify({ config: doc(['a']) }) } },
  { name: 'save', route: ADMIN_ROUTE.save, init: { method: 'POST', body: JSON.stringify({ config: doc(['a']), revision: null }) } },
  { name: 'test', route: ADMIN_ROUTE.test, init: { method: 'POST', body: JSON.stringify({ monitor: { name: 'a', url: url('a') } }) } },
  { name: 'overview', route: ADMIN_ROUTE.overview, init: {} },
]

describe('who may call the admin routes', () => {
  for (const { name, route, init } of ROUTES) {
    it(`${name}: 401 to anonymous, 403 to an editor, 403 to a cookie call without X-EmDash-Request, 200 to an administrator`, async () => {
      const requested: string[] = []
      const host = await configuredHost(doc(['alpha']), (target) => {
        requested.push(target)
        return new Response('ok', { status: 200 })
      })
      const before = await state(host)
      const stored = (await getConfig(host)).data

      expect((await send(host, route, { ...init, headers: CSRF_HEADER })).status).toBe(401)
      expect((await send(host, route, { ...init })).status).toBe(401)
      const editor = await send(host, route, { ...init, user: EDITOR, headers: CSRF_HEADER })
      expect(editor.status).toBe(403)
      expect(editor.error?.code).toBe('FORBIDDEN')
      const noHeader = await send(host, route, { ...init, user: ADMIN })
      expect(noHeader.status).toBe(403)
      expect(noHeader.error?.code).toBe('CSRF_REJECTED')
      // None of the refused calls reached the plugin: no probe, no write.
      expect(requested).toEqual([])
      expect(await state(host)).toEqual(before)
      expect((await getConfig(host)).data).toEqual(stored)

      expect((await send(host, route, { ...init, user: ADMIN, headers: CSRF_HEADER })).status).toBe(200)
    })
  }

  it('lets a token with the admin scope call a route without the CSRF header, and refuses one without the scope', async () => {
    const host = await configuredHost(doc(['alpha']))
    expect((await send(host, ADMIN_ROUTE.config, { user: ADMIN, tokenScopes: ['admin'] })).status).toBe(200)
    expect((await send(host, ADMIN_ROUTE.config, { user: ADMIN, tokenScopes: ['content:read'] })).status).toBe(403)
  })

  it('answers the wrong method with 405 and an unknown route with 404', async () => {
    const host = await configuredHost(doc(['alpha']))
    expect((await send(host, ADMIN_ROUTE.config, asAdmin({ method: 'POST', body: '{}' }))).status).toBe(405)
    expect((await send(host, ADMIN_ROUTE.save, asAdmin())).status).toBe(405)
    expect((await send(host, 'admin/nope', asAdmin())).status).toBe(404)
  })

  it('rejects a body that is not the declared shape with 400 and writes nothing', async () => {
    const host = await configuredHost(doc(['alpha']))
    const before = await state(host)
    expect((await send(host, ADMIN_ROUTE.save, post({ config: doc(['b']) }))).status).toBe(400)
    expect((await send(host, ADMIN_ROUTE.save, post({ config: doc(['b']), revision: 7 }))).status).toBe(400)
    expect((await send(host, ADMIN_ROUTE.test, post({}))).status).toBe(400)
    expect((await send(host, ADMIN_ROUTE.test, post({ slug: 'a', monitor: { name: 'a' } }))).status).toBe(400)
    expect((await send(host, ADMIN_ROUTE.save, asAdmin({ method: 'POST', body: '{not json' }))).status).toBe(400)
    expect(await state(host)).toEqual(before)
  })
})

describe('read the configuration', () => {
  it('returns the stored configuration as an object with its revision and which secrets are set, and writes nothing', async () => {
    const host = await configuredHost(doc(['alpha', 'beta']))
    const before = await state(host)
    const { status, data } = await getConfig(host)
    expect(status).toBe(200)
    expect(data.config).toEqual(doc(['alpha', 'beta']))
    expect(typeof data.revision).toBe('string')
    expect(data.secretsSet).toEqual({ slackWebhookUrl: true, webhookUrls: true, webhookSecret: true, sentryToken: true })
    expect(data.issues).toEqual([])
    expect(await state(host)).toEqual(before)
  })

  it('reports an absent configuration and unset secrets', async () => {
    const host = await newHost(ok)
    const { data } = await getConfig(host)
    expect(data).toEqual({ config: null, revision: null, secretsSet: { slackWebhookUrl: false, webhookUrls: false, webhookSecret: false, sentryToken: false }, issues: [] })
  })

  it('returns a stored configuration the rules reject, with its findings, so it can be fixed', async () => {
    const host = await newHost(ok)
    await host.setConfig(yamlOf({ name: 'Test', sites: [{ name: 'One', url: 'not a url' }] }))
    const { data } = await getConfig(host)
    expect(data.config).toEqual({ name: 'Test', sites: [{ name: 'One', url: 'not a url' }] })
    expect(data.issues).toEqual([expect.objectContaining({ severity: 'error', path: 'sites[0].url' })])
  })

  it('returns no object, but the syntax error, for a stored configuration that is not YAML', async () => {
    const host = await newHost(ok)
    await host.setConfig('sites: [')
    const { data } = await getConfig(host)
    expect(data.config).toBeNull()
    expect(data.issues).toEqual([expect.objectContaining({ severity: 'error', path: '' })])
  })

  it('leaves a stored configuration above the size limit unreadable here and unchanged', async () => {
    const host = await newHost(ok)
    const big = `${yamlOf(doc(['alpha']))}# ${'x'.repeat(MAX_YAML_BYTES)}\n`
    await host.setConfig(big)
    const { data } = await getConfig(host)
    expect(data.config).toBeNull()
    expect(JSON.stringify(data.issues)).toContain('larger than')
  })
})

describe('validate', () => {
  it('accepts a valid configuration and writes nothing', async () => {
    const host = await configuredHost(doc(['alpha']))
    const before = await state(host)
    const { data } = await validate(host, doc(['alpha', 'beta', 'gamma']))
    expect(data).toEqual({ ok: true, issues: [] })
    expect(await state(host)).toEqual(before)
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha']))
  })

  it('returns every core issue with its bracketed field path', async () => {
    const host = await newHost(ok)
    const config = { name: 'Test', sites: [{ name: 'A', url: url('a') }, { name: 'B', url: url('b') }, { name: 'C', url: 'not a url' }, { name: 'D', url: 'also bad' }] }
    const { data } = await validate(host, config)
    expect(data.ok).toBe(false)
    expect(data.issues.map((issue: { severity: string, path: string }) => [issue.severity, issue.path])).toEqual([['error', 'sites[2].url'], ['error', 'sites[3].url']])
  })

  it('returns the plugin-rule errors with their paths too', async () => {
    const host = await newHost(ok)
    const config = { name: 'Test', sites: [{ name: 'Same', url: url('one') }, { name: 'Same', url: url('two') }], notifications: { delivery: 'queue' } }
    const { data } = await validate(host, config)
    expect(data.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(['notifications.delivery', 'sites[1].slug'])
  })

  it('lists warnings with the errors, marked as warnings', async () => {
    const host = await newHost(ok)
    await host.setSecrets({ webhookUrls: `${HOOK}\nnot-a-url` })
    const config = { name: 'Test', sites: [{ name: 'A', url: url('a'), check: 'tcp' }], notifications: { delivery: 'queue' } }
    const { data } = await validate(host, config)
    expect(data.ok).toBe(false)
    expect(data.issues.map((issue: { severity: string, path: string }) => `${issue.severity}:${issue.path}`).sort()).toEqual(['error:notifications.delivery', 'warning:sites[0].check', 'warning:webhookUrls'])
  })

  it('refuses a configuration that is not an object', async () => {
    const host = await newHost(ok)
    for (const config of [null, 'sites: []', [1], 7]) {
      const { data } = await validate(host, config)
      expect(data.ok).toBe(false)
      expect(data.issues).toEqual([expect.objectContaining({ severity: 'error', path: '' })])
    }
    expect((await send(host, ADMIN_ROUTE.validate, post({}))).status).toBe(400)
  })

  it('refuses a configuration above the size limit without truncating it, and accepts exactly the limit', async () => {
    const host = await newHost(ok)
    const withName = (length: number) => ({ name: 'n'.repeat(length), sites: [{ name: 'A', url: url('a') }] })
    const base = new TextEncoder().encode(yamlOf(withName(1))).byteLength - 1
    const exact = await validate(host, withName(MAX_YAML_BYTES - base))
    expect(exact.data).toEqual({ ok: true, issues: [] })
    const over = await validate(host, withName(MAX_YAML_BYTES - base + 1))
    expect(over.data.ok).toBe(false)
    expect(over.data.issues[0].message).toContain('limit is 65536 bytes')
    const saved = await save(host, withName(MAX_YAML_BYTES - base + 1), null)
    expect(saved.data).toMatchObject({ saved: false, reason: 'invalid' })
    expect((await getConfig(host)).data.config).toBeNull()
  })
})

describe('save', () => {
  it('shows every issue with its path, and keeps the stored configuration, when the configuration is invalid', async () => {
    const host = await configuredHost(doc(['alpha']))
    const { data: loaded } = await getConfig(host)
    const before = await state(host)
    const bad = { name: 'Test', sites: [{ name: 'One', url: 'not a url' }, { name: 'Two', url: 'also bad' }] }
    const { data } = await save(host, bad, loaded.revision)
    expect(data.saved).toBe(false)
    expect(data.reason).toBe('invalid')
    expect(data.issues.map((issue: { path: string }) => issue.path)).toEqual(['sites[0].url', 'sites[1].url'])
    expect(await state(host)).toEqual(before)
    expect(await getConfig(host)).toMatchObject({ data: { config: doc(['alpha']), revision: loaded.revision } })
  })

  it('writes the YAML with the loaded revision, returns the new one and reconciles the schedule', async () => {
    const host = await configuredHost(doc(['alpha']))
    // The tasks exist from activation; remove them to see the save put them back.
    await host.runtime.db.deleteFrom('_emdash_cron_tasks').execute()
    expect(await host.tasks()).toEqual([])
    await host.runtime.db.insertInto('options').values({ name: `plugin:statusbeam:${CONFIG_ERROR_KEY}`, value: JSON.stringify({ version: 1, recordedAt: '2026-10-22T00:00:00.000Z', issues: [] }) }).execute()
    const { data: loaded } = await getConfig(host)

    const { status, data } = await save(host, doc(['alpha', 'beta']), loaded.revision)
    expect(status).toBe(200)
    expect(data).toMatchObject({ saved: true, config: doc(['alpha', 'beta']), issues: [], schedule: { scheduled: [CHECK_TASK, MAINTENANCE_TASK], cancelled: [] } })
    expect(data.revision).not.toBe(loaded.revision)
    expect(await host.kvKeys()).not.toContain(CONFIG_ERROR_KEY)
    expect((await host.tasks()).map(task => task.name).sort()).toEqual([CHECK_TASK, MAINTENANCE_TASK])
    const reread = (await getConfig(host)).data
    expect(reread.config).toEqual(doc(['alpha', 'beta']))
    expect(reread.revision).toBe(data.revision)

    // The saved revision works for the next save from the same page, with no reload.
    expect((await save(host, doc(['alpha']), data.revision)).data).toMatchObject({ saved: true })
  })

  it('moves only a missing or changed task on a later save, so a task that is due is not postponed', async () => {
    const host = await configuredHost(doc(['alpha']))
    const first = (await save(host, doc(['alpha']), (await getConfig(host)).data.revision)).data
    const nextRun = Object.fromEntries((await host.tasks()).map(task => [task.name, task.nextRunAt]))
    const second = (await save(host, doc(['alpha', 'beta']), first.revision)).data
    expect(second.schedule).toEqual({ scheduled: [], cancelled: [] })
    expect(Object.fromEntries((await host.tasks()).map(task => [task.name, task.nextRunAt]))).toEqual(nextRun)
  })

  it('refuses a save after someone else\'s save, writes nothing and returns the current configuration', async () => {
    const host = await configuredHost(doc(['alpha']))
    const mine = (await getConfig(host)).data.revision
    const theirs = await save(host, doc(['alpha', 'beta']), (await getConfig(host)).data.revision)
    expect(theirs.data.saved).toBe(true)

    await host.runtime.db.deleteFrom('_emdash_cron_tasks').execute()
    const tasksBefore = await host.tasks()
    expect(tasksBefore).toEqual([])
    const { status, data } = await save(host, doc(['alpha', 'delta']), mine)
    expect(status).toBe(200)
    expect(data).toMatchObject({ saved: false, reason: 'stale', config: doc(['alpha', 'beta']), revision: theirs.data.revision })
    expect(data.secretsSet).toEqual({ slackWebhookUrl: true, webhookUrls: true, webhookSecret: true, sentryToken: true })
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha', 'beta']))
    expect(await host.tasks()).toEqual(tasksBefore)

    // The refused revision stays refused; the one it answered with goes through.
    expect((await save(host, doc(['alpha', 'delta']), mine)).data).toMatchObject({ saved: false, reason: 'stale' })
    expect((await save(host, doc(['alpha', 'delta']), data.revision)).data).toMatchObject({ saved: true })
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha', 'delta']))
  })

  it('refuses a save from an older tab of the same administrator after a newer tab saved', async () => {
    const host = await configuredHost(doc(['alpha']))
    const tab1 = (await getConfig(host)).data.revision
    const tab2 = (await getConfig(host)).data.revision
    expect((await save(host, doc(['alpha', 'beta']), tab2)).data.saved).toBe(true)
    expect((await save(host, doc(['alpha', 'delta']), tab1)).data).toMatchObject({ saved: false, reason: 'stale' })
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha', 'beta']))
  })

  it('refuses a save whose revision was never issued, or that expects no configuration while one exists', async () => {
    const host = await configuredHost(doc(['alpha']))
    for (const revision of ['nope', '{"r":1}', 'x'.repeat(128), null]) {
      expect((await save(host, doc(['alpha', 'beta']), revision)).data).toMatchObject({ saved: false, reason: 'stale' })
    }
    // A revision the host cannot hold is a malformed request, not a stale one.
    expect((await save(host, doc(['alpha', 'beta']), '')).status).toBe(400)
    expect((await save(host, doc(['alpha', 'beta']), 'x'.repeat(129))).status).toBe(400)
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha']))
  })

  it('creates the first configuration only while none exists', async () => {
    const host = await newHost(ok)
    const { data: loaded } = await getConfig(host)
    expect(loaded.revision).toBeNull()
    const first = await save(host, doc(['alpha']), null)
    expect(first.data).toMatchObject({ saved: true })
    expect((await save(host, doc(['beta']), null)).data).toMatchObject({ saved: false, reason: 'stale' })
    expect((await getConfig(host)).data.config).toEqual(doc(['alpha']))
  })

  it('saves a configuration with warnings and returns them', async () => {
    const host = await newHost(ok)
    const { data } = await save(host, { name: 'Test', sites: [{ name: 'A', url: url('a'), check: 'tcp' }] }, null)
    expect(data).toMatchObject({ saved: true, issues: [expect.objectContaining({ severity: 'warning', path: 'sites[0].check' })] })
  })

  it('stores YAML the scheduled run reads, so a saved monitor is checked', async () => {
    const requested: string[] = []
    const host = await configuredHost(doc(['alpha']), (target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    await save(host, doc(['alpha', 'beta']), (await getConfig(host)).data.revision)
    await host.cron(CHECK_TASK)
    expect(requested.sort()).toEqual([url('alpha'), url('beta')])
  })
})

describe('test one monitor', () => {
  it('probes a saved monitor by slug and returns its status, response code and latency, writing nothing', async () => {
    const requested: string[] = []
    const host = await configuredHost(doc(['alpha', 'beta']), (target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    const before = await state(host)
    const { status, data } = await testMonitor(host, { slug: 'beta' })
    expect(status).toBe(200)
    expect(data).toMatchObject({ tested: true, result: { slug: 'beta', status: 'up', code: 200 } })
    expect(typeof data.result.responseTime).toBe('number')
    expect(requested).toEqual([url('beta')])
    // No bucket, snapshot, key-value entry, schedule or delivery.
    expect(await state(host)).toEqual(before)
    expect(await host.snapshot()).toBeNull()
    expect(await host.buckets()).toEqual([])
  })

  it('probes an unsaved edit and grades a failing target down with its code', async () => {
    const requested: string[] = []
    const host = await configuredHost(doc(['alpha']), (target) => {
      requested.push(target)
      return new Response('no', { status: 503 })
    })
    const before = await state(host)
    const { data } = await testMonitor(host, { monitor: { name: 'Gamma', url: url('gamma') } })
    expect(data).toMatchObject({ tested: true, result: { slug: 'gamma', status: 'down', code: 503 } })
    expect(requested).toEqual([url('gamma')])
    expect(await state(host)).toEqual(before)
  })

  it('sends no notification when the tested monitor is down', async () => {
    const delivered: string[] = []
    const host = await configuredHost(doc(['alpha']), (target) => {
      if (target.includes('/slack/') || target.includes('/hook/')) {
        delivered.push(target)
      }
      return new Response('no', { status: 500 })
    })
    await testMonitor(host, { slug: 'alpha' })
    await testMonitor(host, { monitor: { name: 'Other', url: url('other') } })
    expect(delivered).toEqual([])
  })

  it('returns the monitor\'s errors with paths relative to it, without probing', async () => {
    const requested: string[] = []
    const host = await configuredHost(doc(['alpha']), (target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    const { data } = await testMonitor(host, { monitor: { name: 'Bad', url: 'not a url' } })
    expect(data).toMatchObject({ tested: false, reason: 'invalid', issues: [expect.objectContaining({ severity: 'error', path: 'url' })] })
    expect((await testMonitor(host, { monitor: 'nope' })).data).toMatchObject({ tested: false, reason: 'invalid' })
    expect(requested).toEqual([])
  })

  it('says so for an unknown slug and for no saved configuration, without probing', async () => {
    const requested: string[] = []
    const record: Internet = (target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    }
    const host = await configuredHost(doc(['alpha']), record)
    expect((await testMonitor(host, { slug: 'nope' })).data).toMatchObject({ tested: false, reason: 'not-found' })
    const empty = await newHost(record)
    expect((await testMonitor(empty, { slug: 'alpha' })).data).toMatchObject({ tested: false, reason: 'not-found' })
    expect(requested).toEqual([])
  })

  it('answers invalid with the findings, not not-found, when the saved configuration does not validate', async () => {
    const requested: string[] = []
    const host = await newHost((target) => {
      requested.push(target)
      return new Response('ok', { status: 200 })
    })
    await host.setConfig(yamlOf({ name: 'Test', sites: [{ name: 'One', slug: 'one', url: 'not a url' }] }))
    const { data } = await testMonitor(host, { slug: 'one' })
    expect(data).toMatchObject({ tested: false, reason: 'invalid', issues: [expect.objectContaining({ severity: 'error', path: 'sites[0].url' })] })
    expect(requested).toEqual([])
  })

  it('refuses a loopback, private or cloud-metadata address, also behind a redirect, and never requests it', async () => {
    const reached: string[] = []
    const host = await configuredHost(doc(['alpha']), (target) => {
      reached.push(target)
      if (target.endsWith('/bounce')) {
        return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      return new Response('ok', { status: 200 })
    })
    const before = await state(host)
    const targets = ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', url('bounce')]
    for (const target of targets) {
      const { data } = await testMonitor(host, { monitor: { name: 'Probe', url: target } })
      expect(data).toMatchObject({ tested: true, result: { status: 'down', code: 0 } })
      expect(data.result.error).toMatch(/non-public IP address|internal hosts/)
    }
    // A saved monitor is held to the same guard.
    await save(host, { name: 'Test', sites: [{ name: 'Meta', url: 'http://169.254.169.254/' }] }, (await getConfig(host)).data.revision)
    expect((await testMonitor(host, { slug: 'meta' })).data).toMatchObject({ tested: true, result: { status: 'down', code: 0 } })
    // Only the redirecting URL was requested, and nothing was written.
    expect(reached).toEqual([url('bounce')])
    expect((await state(host)).buckets).toEqual(before.buckets)
    expect(await host.snapshot()).toBeNull()
  })

  it('polls a Sentry monitor with the stored token and refuses a webhook-only one or a missing token without probing', async () => {
    const seenRequests: Array<{ url: string, auth: string | null }> = []
    const internet: Internet = (target, init) => {
      seenRequests.push({ url: target, auth: new Headers(init?.headers).get('authorization') })
      return new Response('[]', { status: 200 })
    }
    const config = {
      name: 'Test',
      sites: [
        { name: 'polled', check: 'sentry', url: url('polled'), sentry: { org: 'acme', host: `https://${HOST}` } },
        { name: 'hooked', check: 'sentry', url: url('hooked') },
      ],
    }
    const host = await configuredHost(config, internet)
    const polled = await testMonitor(host, { slug: 'polled' })
    expect(polled.data).toMatchObject({ tested: true, result: { slug: 'polled', status: 'up' } })
    expect(seenRequests).toEqual([{ url: expect.stringContaining('/api/0/organizations/acme/issues/'), auth: `Bearer ${SECRETS.sentryToken}` }])

    expect((await testMonitor(host, { slug: 'hooked' })).data).toMatchObject({ tested: false, reason: 'webhook-only' })

    const noToken = await newHost(internet)
    await noToken.setConfig(yamlOf(config))
    expect((await testMonitor(noToken, { slug: 'polled' })).data).toMatchObject({ tested: false, reason: 'no-token' })
    expect(seenRequests).toHaveLength(1)
  })

  it('grades a hung target down at the deadline', async () => {
    const host = await configuredHost(doc(['alpha']), () => new Promise<Response>(() => {}), { deadlineMs: 300 })
    const started = Date.now()
    const { data } = await testMonitor(host, { slug: 'alpha' })
    expect(data).toMatchObject({ tested: true, result: { status: 'down', code: 0 } })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('overview', () => {
  it('lists every monitor with its status, 90-day history, latest latency and pending for the never-checked', async () => {
    const host = await configuredHost(doc(['alpha', 'beta', 'gamma']))
    await host.cron(CHECK_TASK)
    // A monitor added after the last check has never been checked.
    await save(host, doc(['alpha', 'beta', 'gamma', 'delta']), (await getConfig(host)).data.revision)
    const before = await state(host)
    const { status, data } = await overview(host)
    expect(status).toBe(200)
    expect(data.configured).toBe(true)
    expect(data.updatedAt).toEqual(expect.any(String))
    expect(data.status).toBe('operational')
    expect(data.monitors.map((m: { slug: string }) => m.slug)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    const alpha = data.monitors[0]
    expect(alpha).toMatchObject({ slug: 'alpha', name: 'alpha', status: 'up', uptimeDay: '100%' })
    expect(alpha.pending).toBeUndefined()
    expect(typeof alpha.responseTime).toBe('number')
    expect(alpha.history).toHaveLength(90)
    expect(alpha.history.at(-1)).toMatchObject({ status: 'up' })
    expect(data.monitors[3]).toMatchObject({ slug: 'delta', pending: true })
    expect(await state(host)).toEqual(before)
  })

  it('reports the worst status of the checked monitors and ignores a pending one', async () => {
    const host = await configuredHost(doc(['good', 'bad']), target => (target.endsWith('/bad') ? new Response('no', { status: 503 }) : new Response('ok', { status: 200 })))
    expect((await overview(host)).data).toMatchObject({ updatedAt: null, status: 'operational', monitors: [{ pending: true }, { pending: true }] })
    await host.cron(CHECK_TASK)
    const { data } = await overview(host)
    expect(data.status).toBe('major_outage')
    expect(data.monitors.map((m: { slug: string, status: string }) => [m.slug, m.status])).toEqual([['good', 'up'], ['bad', 'down']])
  })

  it('reports a webhook-only monitor as pending until its first event', async () => {
    const host = await configuredHost({ name: 'Test', sites: [{ name: 'hook', check: 'sentry', url: url('hook') }, { name: 'alpha', url: url('alpha') }] })
    await host.cron(CHECK_TASK)
    const { data } = await overview(host)
    expect(data.monitors.find((m: { slug: string }) => m.slug === 'hook')).toMatchObject({ pending: true })
    expect(data.monitors.find((m: { slug: string }) => m.slug === 'alpha')).not.toHaveProperty('pending')
  })

  it('says so before any configuration exists, and when the stored one is rejected, instead of reporting an outage', async () => {
    const empty = await newHost(ok)
    expect((await overview(empty)).data).toMatchObject({ configured: false, configIssues: [], monitors: [], updatedAt: null })
    const rejected = await newHost(ok)
    await rejected.setConfig(yamlOf({ name: 'Test', sites: [{ name: 'One', url: 'not a url' }] }))
    const { data } = await overview(rejected)
    expect(data).toMatchObject({ configured: false, monitors: [] })
    expect(data.configIssues).toEqual([expect.objectContaining({ severity: 'error', path: 'sites[0].url' })])
  })

  it('reads the snapshot the check wrote, and nothing else', async () => {
    const host = await configuredHost(doc(['alpha']))
    await host.cron(CHECK_TASK)
    const snapshot = await host.snapshot() as PollSnapshot
    const { data } = await overview(host)
    expect(data.updatedAt).toBe(snapshot.updatedAt)
    expect(data.monitors[0].responseTime).toBe(snapshot.monitors[0]?.result?.responseTime)
  })
})

describe('secrets', () => {
  it('never appear in any admin response, and only which are set is reported', async () => {
    const host = await configuredHost({
      name: 'Test',
      sites: [{ name: 'polled', check: 'sentry', url: url('polled'), sentry: { org: 'acme', host: `https://${HOST}` } }, { name: 'alpha', url: url('alpha') }],
    })
    await host.cron(CHECK_TASK)
    const replies: Array<Reply<any>> = []
    const run = async (promise: Promise<Reply<any>>) => {
      replies.push(await promise)
    }
    await run(getConfig(host))
    await run(validate(host, { name: 'Test', sites: [{ name: 'A', url: 'nope' }] }))
    await run(save(host, { name: 'Test', sites: [{ name: 'A', url: 'nope' }] }, null))
    await run(save(host, doc(['alpha']), 'stale-revision'))
    await run(save(host, doc(['alpha']), (await getConfig(host)).data.revision))
    await run(testMonitor(host, { slug: 'alpha' }))
    await run(testMonitor(host, { monitor: { name: 'Sentry', check: 'sentry', url: url('s'), sentry: { org: 'acme', host: `https://${HOST}` } } }))
    await run(testMonitor(host, { monitor: { name: 'Bad', url: 'nope' } }))
    await run(overview(host))
    await run(send(host, ADMIN_ROUTE.config, { user: EDITOR, headers: CSRF_HEADER }))
    expect(replies.length).toBe(10)
    for (const reply of replies) {
      const text = JSON.stringify(reply)
      for (const secret of SECRET_VALUES) {
        expect(text).not.toContain(secret)
      }
    }
    // The first read said which are set.
    expect(replies[0]?.data.secretsSet).toEqual({ slackWebhookUrl: true, webhookUrls: true, webhookSecret: true, sentryToken: true })
  })

  it('reports a secret that is cleared as not set', async () => {
    const host = await configuredHost(doc(['alpha']))
    await host.setSecrets({ sentryToken: '', webhookSecret: '' })
    expect((await getConfig(host)).data.secretsSet).toEqual({ slackWebhookUrl: true, webhookUrls: true, webhookSecret: false, sentryToken: false })
  })
})
