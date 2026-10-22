import type { BlockResponse } from '@emdash-cms/blocks'
import type { ConfigErrorRecord } from '../src/config'
import type { ShardSnapshot } from '../src/snapshot'
import { validateBlockResponse } from '@emdash-cms/blocks/server'
import { describe, expect, it } from 'bun:test'
import { adminHandler } from '../src/admin'
import { MAX_YAML_BYTES, parseRunActionId, runActionId } from '../src/admin-view'
import { CALL_BUDGET } from '../src/budget'
import { CONFIG_ERROR_KEY } from '../src/config'
import { createFakeContext, monitorsYaml } from './fake-context'

type Fake = ReturnType<typeof createFakeContext>

const request = { url: 'https://example.com/', method: 'POST', headers: {} }
const admin = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 50, createdAt: '2026-01-01T00:00:00.000Z' }
const otherAdmin = { ...admin, id: 'admin-2' }
const editor = { ...admin, id: 'editor-1', role: 40 }

type Caller = typeof admin | undefined

function call(fake: Fake, input: unknown, ...rest: [user?: Caller]): Promise<BlockResponse> {
  // An explicit `undefined` is a request with no user; omitting the argument is an administrator.
  const user = rest.length === 0 ? admin : rest[0]
  return adminHandler({ input, request, user }, fake.ctx) as Promise<BlockResponse>
}

const pageLoad = { type: 'page_load', page: '/config' }
/** A submit of the configuration form; `actionId` is the form's submit id, which carries the revision it was loaded with. */
const submit = (values: Record<string, unknown>, actionId = 'run') => ({ type: 'form_submit', action_id: actionId, page: '/config', values })

/** Every response must be a response the host's Block Kit validator accepts, or the page fails to render. */
function expectValid(response: BlockResponse): void {
  const result = validateBlockResponse(response, { allowedImageHosts: [], pluginPagePaths: ['/config'] })
  expect(result.valid, JSON.stringify(result.errors)).toBe(true)
}

function allText(response: BlockResponse): string {
  return JSON.stringify(response.blocks)
}

function formOf(response: BlockResponse) {
  const form = response.blocks.find(block => block.type === 'form')
  if (!form || form.type !== 'form') {
    throw new Error('no form in the response')
  }
  return form
}

/** Load the page as `user` (an administrator by default), as one browser tab does, and return its form's submit id. */
async function loadForm(fake: Fake, ...rest: [user?: Caller]): Promise<string> {
  return formOf(await call(fake, pageLoad, ...rest)).submit.action_id
}

const WRITE_CALLS = /^(?:settings\.(?:set|compareAndSet|delete)|kv\.(?:set|delete)|storage\.|cron\.(?:schedule|cancel))/

const valid = monitorsYaml(['alpha', 'beta'])
const OLD = valid
const NEW = monitorsYaml(['alpha', 'beta', 'gamma'])

describe('the administrator gate (AC-017)', () => {
  const interactions: Array<[string, unknown]> = [
    ['page load', pageLoad],
    ['widget load', { type: 'page_load', page: 'widget:status' }],
    ['validate', submit({ yaml: valid, operation: 'validate' })],
    ['save', submit({ yaml: valid, operation: 'save' })],
    ['test site', submit({ yaml: valid, operation: 'test', slug: 'alpha' })],
    ['reload', { type: 'block_action', action_id: 'reload', page: '/config' }],
  ]
  const callers: Array<[string, Caller]> = [['an editor', editor], ['a request with no user', undefined]]

  for (const [who, user] of callers) {
    for (const [name, input] of interactions) {
      it(`refuses ${who} on ${name} before any bridge call or write`, async () => {
        const fake = createFakeContext({ config: OLD })
        const response = await call(fake, input, user)
        expect(fake.bridgeCalls).toEqual([])
        expect(fake.kv.size).toBe(0)
        expect(fake.settings.get('config')).toBe(OLD)
        expect(allText(response)).toContain('Administrators only')
        expect(allText(response)).not.toContain('alpha')
        expectValid(response)
      })
    }
  }

  it('serves an administrator the same page', async () => {
    const fake = createFakeContext({ config: OLD })
    expect(allText(await call(fake, pageLoad))).toContain('StatusBeam configuration')
  })
})

describe('the configuration page', () => {
  it('shows the stored YAML in one multiline field and carries the loaded revision in the form itself, with no write', async () => {
    const fake = createFakeContext({ config: OLD })
    const response = await call(fake, pageLoad)
    expectValid(response)
    const form = formOf(response)
    expect(form.fields[0]).toMatchObject({ type: 'text_input', action_id: 'yaml', multiline: true, initial_value: OLD })
    expect(form.submit.action_id).toBe(runActionId('r0'))
    expect(parseRunActionId(form.submit.action_id)).toEqual({ revision: 'r0' })
    expect(fake.kv.size).toBe(0)
    expect(fake.bridgeCalls).toEqual(['settings.getVersioned', 'kv.get', 'kv.list'])
  })

  it('shows the run-time error from the scheduled run as a persistent banner, and body-limit notes briefly', async () => {
    const fake = createFakeContext({ config: OLD })
    const record: ConfigErrorRecord = {
      version: 1,
      recordedAt: '2026-10-22T10:00:00.000Z',
      issues: [{ severity: 'error', path: 'sites[0].url', message: 'Invalid URL' }],
    }
    fake.kv.set(CONFIG_ERROR_KEY, record)
    const snapshot: ShardSnapshot = {
      version: 2,
      shard: 0,
      updatedAt: '2026-10-22T10:00:00.000Z',
      deliveries: [],
      capacityError: '3 notification destinations leave no call for a probe',
      monitors: [{ slug: 'alpha', result: null, days: [], totals: {}, warning: { limit: 'body', since: '2026-10-21T00:00:00.000Z', lastSeen: '2026-10-22T00:00:00.000Z' } }],
    }
    fake.kv.set('snapshot:0', snapshot)
    const response = await call(fake, pageLoad)
    expectValid(response)
    const banners = response.blocks.filter(block => block.type === 'banner')
    expect(banners[0]).toMatchObject({ variant: 'error', title: 'The stored configuration failed validation at run time' })
    expect(allText(response)).toContain('Error at sites[0].url: Invalid URL')
    expect(allText(response)).toContain('Monitor \\"alpha\\" is unsupported')
    expect(allText(response)).toContain('3 notification destinations leave no call for a probe')
  })

  it('refuses a YAML above the Block Kit string limit with a message and never truncates it', async () => {
    const fake = createFakeContext({ config: OLD })
    const big = `${monitorsYaml(['alpha'])}\n# ${'x'.repeat(MAX_YAML_BYTES)}`
    for (const operation of ['validate', 'save', 'test']) {
      const response = await call(fake, submit({ yaml: big, operation, slug: 'alpha' }))
      expectValid(response)
      expect(allText(response)).toContain('The configuration is too large')
      expect(allText(response)).toContain('Nothing was validated, saved or truncated')
      expect(response.toast?.type).toBe('error')
    }
    expect(fake.bridgeCalls).toEqual([])
    expect(fake.settings.get('config')).toBe(OLD)
  })

  it('accepts a YAML of exactly the limit (it then fails validation, not the size check)', async () => {
    const fake = createFakeContext({ config: OLD })
    const body = 'x'.repeat(MAX_YAML_BYTES)
    const response = await call(fake, submit({ yaml: body, operation: 'validate' }))
    expect(allText(response)).not.toContain('too large')
    expect(allText(response)).toContain('Error at')
  })
})

describe('Validate (FR-16)', () => {
  it('checks the editor text without saving, with no write of any kind', async () => {
    const fake = createFakeContext({ config: OLD })
    const response = await call(fake, submit({ yaml: NEW, operation: 'validate' }))
    expectValid(response)
    expect(allText(response)).toContain('The configuration is valid')
    expect(response.toast).toMatchObject({ type: 'success' })
    expect(fake.settings.get('config')).toBe(OLD)
    expect(fake.bridgeCalls.filter(c => WRITE_CALLS.test(c))).toEqual([])
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect(fake.kv.size).toBe(0)
  })
})

describe('Save (FR-15)', () => {
  // Two core-schema errors, then (valid core, plugin rules) two plugin errors.
  const invalid = ['name: Test', 'sites:', '  - name: One', '    url: not a url', '  - name: Two', '    url: also bad'].join('\n')
  const pluginInvalid = [
    'name: Test',
    'sites:',
    '  - name: Same',
    '    url: https://one.example.com/',
    '  - name: Same',
    '    url: https://same.example.com/',
    'notifications:',
    '  delivery: queue',
  ].join('\n')

  it('shows every issue with its path and keeps the stored configuration (AC-014, AC-015)', async () => {
    const fake = createFakeContext({ config: OLD })
    const form = await loadForm(fake)
    fake.bridgeCalls.length = 0
    const response = await call(fake, submit({ yaml: invalid, operation: 'save' }, form))
    expectValid(response)
    const text = allText(response)
    expect(text).toContain('Error at sites[0].url')
    expect(text).toContain('Error at sites[1].url')
    expect(response.toast).toMatchObject({ type: 'error' })
    expect(fake.settings.get('config')).toBe(OLD)
    expect(fake.bridgeCalls.filter(c => WRITE_CALLS.test(c))).toEqual([])
    // The editor keeps the rejected text for correction.
    expect(formOf(response).fields[0]).toMatchObject({ initial_value: invalid })
  })

  it('shows every plugin-rule error with its path too', async () => {
    const fake = createFakeContext({ config: OLD })
    const form = await loadForm(fake)
    const response = await call(fake, submit({ yaml: pluginInvalid, operation: 'save' }, form))
    expect(allText(response)).toContain('Error at sites[1].slug')
    expect(allText(response)).toContain('Error at notifications.delivery')
    expect(fake.settings.get('config')).toBe(OLD)
  })

  it('lists warnings with the errors, marked as warnings', async () => {
    const fake = createFakeContext({ config: OLD, settings: { webhookUrls: 'https://ok.example.com/\nnot-a-url' } })
    const withTcp = ['name: Test', 'sites:', '  - name: A', '    url: https://a.example.com/', '    check: tcp', 'notifications:', '  delivery: queue'].join('\n')
    const response = await call(fake, submit({ yaml: withTcp, operation: 'save' }))
    expect(allText(response)).toContain('Warning at sites[0].check')
    expect(allText(response)).toContain('Warning at webhookUrls')
    expect(allText(response)).toContain('Error at notifications.delivery')
  })

  it('writes with compareAndSet against the loaded revision, schedules the shards, clears the run-time error and stays in budget', async () => {
    const fake = createFakeContext({ config: OLD })
    fake.kv.set(CONFIG_ERROR_KEY, { version: 1, recordedAt: '2026-10-22T00:00:00.000Z', issues: [] })
    const form = await loadForm(fake)
    fake.bridgeCalls.length = 0

    const response = await call(fake, submit({ yaml: NEW, operation: 'save' }, form))
    expectValid(response)
    expect(fake.settings.get('config')).toBe(NEW)
    expect(response.toast).toMatchObject({ type: 'success', message: 'Configuration saved' })
    expect(fake.kv.has(CONFIG_ERROR_KEY)).toBe(false)
    expect([...fake.tasks.keys()].sort()).toEqual(['check-0', 'maintenance'])
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect(fake.bridgeCalls.slice(0, 2)).toEqual(['settings.list', 'settings.compareAndSet'])
    expect(fake.bridgeCalls.filter(c => c === 'kv.get' || c === 'kv.set')).toEqual([])
    expect(fake.bridgeCalls.some(c => c.startsWith('log.') || c.startsWith('storage.'))).toBe(false)

    // The saved form comes back carrying the new revision, so a second save from the same page needs no reload.
    const saved = formOf(response).submit.action_id
    expect(parseRunActionId(saved)).toEqual({ revision: 'r1' })
    const again = await call(fake, submit({ yaml: OLD, operation: 'save' }, saved))
    expect(fake.settings.get('config')).toBe(OLD)
    expect(again.toast?.type).toBe('success')
  })

  it('stays within the budget when a save must schedule a full set of shards, and reports what it deferred', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const fake = createFakeContext({ config: OLD })
    const form = await loadForm(fake)
    fake.bridgeCalls.length = 0
    const response = await call(fake, submit({ yaml: monitorsYaml(names), operation: 'save' }, form))
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect(fake.settings.get('config')).toBe(monitorsYaml(names))
    expect(allText(response)).toContain('Some scheduled tasks are still pending')
    // Nine operations (maintenance first, then 8 shards); this save had calls for 5 of them.
    expect(allText(response)).toContain('4 scheduling operations did not fit')
    expect([...fake.tasks.keys()]).toEqual(['maintenance', 'check-0', 'check-1', 'check-2', 'check-3'])
    // A second save finishes the schedule.
    const second = await call(fake, submit({ yaml: monitorsYaml(names), operation: 'save' }, formOf(response).submit.action_id))
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET * 2)
    expect(allText(second)).not.toContain('Some scheduled tasks are still pending')
    expect([...fake.tasks.keys()].sort()).toEqual(['check-0', 'check-1', 'check-2', 'check-3', 'check-4', 'check-5', 'check-6', 'check-7', 'maintenance'])
  })

  it('refuses a save after someone else\'s save, keeps their configuration and says to reload (AC-016)', async () => {
    const fake = createFakeContext({ config: OLD })
    const myForm = await loadForm(fake)
    const theirForm = await loadForm(fake, otherAdmin)
    // The other administrator saves first.
    const theirs = await call(fake, submit({ yaml: NEW, operation: 'save' }, theirForm), otherAdmin)
    expect(theirs.toast?.type).toBe('success')
    expect(fake.settings.get('config')).toBe(NEW)

    fake.bridgeCalls.length = 0
    const mine = monitorsYaml(['alpha', 'delta'])
    const response = await call(fake, submit({ yaml: mine, operation: 'save' }, myForm))
    expectValid(response)
    expect(fake.settings.get('config')).toBe(NEW)
    expect(fake.bridgeCalls).toContain('settings.compareAndSet')
    expect(allText(response)).toContain('Reload to see the current configuration')
    expect(response.toast).toMatchObject({ type: 'error' })
    expect(JSON.stringify(response.blocks.find(block => block.type === 'actions'))).toContain('"action_id":"reload"')
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect(fake.bridgeCalls.filter(c => c === 'cron.schedule' || c === 'cron.cancel')).toEqual([])

    // The refused form keeps its old revision, so saving it again is refused again.
    const resubmitted = await call(fake, submit({ yaml: mine, operation: 'save' }, formOf(response).submit.action_id))
    expect(allText(resubmitted)).toContain('Reload to see the current configuration')
    expect(fake.settings.get('config')).toBe(NEW)

    // Reload re-renders the form with the current revision, after which the save goes through.
    const reloaded = await call(fake, { type: 'block_action', action_id: 'reload', page: '/config' })
    const retry = await call(fake, submit({ yaml: mine, operation: 'save' }, formOf(reloaded).submit.action_id))
    expect(retry.toast?.type).toBe('success')
    expect(fake.settings.get('config')).toBe(mine)
  })

  it('refuses a save from an older tab of the same administrator after a newer tab saved', async () => {
    const fake = createFakeContext({ config: OLD })
    const tab1 = await loadForm(fake)
    const tab2 = await loadForm(fake)
    const second = await call(fake, submit({ yaml: NEW, operation: 'save' }, tab2))
    expect(second.toast?.type).toBe('success')

    const first = await call(fake, submit({ yaml: monitorsYaml(['alpha', 'delta']), operation: 'save' }, tab1))
    expectValid(first)
    expect(allText(first)).toContain('Reload to see the current configuration')
    expect(first.toast).toMatchObject({ type: 'error' })
    expect(fake.settings.get('config')).toBe(NEW)
  })

  it('refuses a save from a page that was never loaded, or whose form carries no readable revision', async () => {
    const fake = createFakeContext({ config: OLD })
    const response = await call(fake, submit({ yaml: NEW, operation: 'save' }))
    expect(fake.settings.get('config')).toBe(OLD)
    expect(allText(response)).toContain('Reload')
    for (const actionId of ['run:', 'run:%7B', `run:${encodeURIComponent('{"r":1}')}`]) {
      const unreadable = await call(fake, submit({ yaml: NEW, operation: 'save' }, actionId))
      expect(allText(unreadable)).toContain('Reload to see the current configuration')
    }
    expect(fake.settings.get('config')).toBe(OLD)
    expect(fake.bridgeCalls).not.toContain('settings.compareAndSet')
  })

  it('creates the first configuration only while none exists', async () => {
    const fake = createFakeContext()
    const form = await loadForm(fake)
    expect(parseRunActionId(form)).toEqual({ revision: null })
    const saved = await call(fake, submit({ yaml: NEW, operation: 'save' }, form))
    expect(saved.toast?.type).toBe('success')
    expect(fake.settings.get('config')).toBe(NEW)
  })
})

describe('Test site (FR-17)', () => {
  it('shows the graded status, code and latency from one fetch, and writes nothing (AC-025, AC-026)', async () => {
    const fetched: string[] = []
    const fake = createFakeContext({
      config: OLD,
      fetch: async (url) => {
        fetched.push(url)
        return new Response('ok', { status: 200 })
      },
    })
    const response = await call(fake, submit({ yaml: NEW, operation: 'test', slug: 'gamma' }))
    expectValid(response)
    expect(fetched).toEqual(['https://gamma.example.com/'])
    const fields = response.blocks.find(block => block.type === 'fields')
    expect(JSON.stringify(fields)).toContain('{"label":"Status","value":"up"}')
    expect(JSON.stringify(fields)).toContain('{"label":"HTTP code","value":"200"}')
    expect(JSON.stringify(fields)).toMatch(/"label":"Latency","value":"\d+ ms"/)
    expect(JSON.stringify(fields)).toContain('the YAML in the editor')
    // Settings and one fetch, plus the two banner reads; nothing else.
    expect(fake.bridgeCalls.filter(c => c !== 'kv.get' && c !== 'kv.list')).toEqual(['settings.list', 'http.fetch'])
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(CALL_BUDGET)
    expect(fake.bridgeCalls.filter(c => WRITE_CALLS.test(c))).toEqual([])
    expect(fake.kv.size).toBe(0)
    expect(fake.rows.size).toBe(0)
    expect(fake.settings.get('config')).toBe(OLD)
  })

  it('grades a failing target down with its code', async () => {
    const fake = createFakeContext({ config: OLD, fetch: async () => new Response('no', { status: 503 }) })
    const response = await call(fake, submit({ yaml: OLD, operation: 'test', slug: 'alpha' }))
    expect(JSON.stringify(response.blocks.find(block => block.type === 'fields'))).toContain('{"label":"Status","value":"down"}')
    expect(response.toast?.type).toBe('info')
    expect(fake.rows.size).toBe(0)
  })

  it('tests the stored configuration, and says so, when the editor YAML is invalid', async () => {
    const fake = createFakeContext({ config: OLD })
    const response = await call(fake, submit({ yaml: 'sites: [', operation: 'test', slug: 'beta' }))
    expect(allText(response)).toContain('Tested the stored configuration')
    expect(allText(response)).toContain('the stored configuration (the editor YAML is invalid)')
    expect(fake.bridgeCalls.filter(c => c === 'http.fetch')).toHaveLength(1)
  })

  it('polls a Sentry monitor with the stored token, and refuses a webhook-only one or a missing token without probing', async () => {
    const yaml = [
      'name: Test',
      'sites:',
      '  - name: polled',
      '    check: sentry',
      '    url: https://polled.example.com/',
      '    sentry:',
      '      org: acme',
      '  - name: hooked',
      '    check: sentry',
      '    url: https://hooked.example.com/',
    ].join('\n')
    const seen: Array<{ url: string, auth: string | null }> = []
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response('[]', { status: 200 })
    }
    const withToken = createFakeContext({ config: yaml, settings: { sentryToken: ' tok ' }, fetch })
    const polled = await call(withToken, submit({ yaml, operation: 'test', slug: 'polled' }))
    expectValid(polled)
    expect(JSON.stringify(polled.blocks.find(block => block.type === 'fields'))).toContain('{"label":"Status","value":"up"}')
    expect(seen).toEqual([{ url: expect.stringContaining('/api/0/organizations/acme/issues/'), auth: 'Bearer tok' }])

    const hooked = await call(withToken, submit({ yaml, operation: 'test', slug: 'hooked' }))
    expectValid(hooked)
    expect(allText(hooked)).toContain('Webhook-only Sentry monitors cannot be tested here')
    const noToken = createFakeContext({ config: yaml, fetch })
    const missing = await call(noToken, submit({ yaml, operation: 'test', slug: 'polled' }))
    expect(allText(missing)).toContain('Set the Sentry token to test this monitor')
    expect(seen).toHaveLength(1)
    expect(withToken.bridgeCalls.filter(c => c === 'http.fetch')).toHaveLength(1)
    expect(noToken.bridgeCalls.filter(c => c === 'http.fetch')).toEqual([])
  })

  it('refuses an unknown slug, a blank slug and a missing configuration without probing', async () => {
    const fake = createFakeContext({ config: OLD })
    expect(allText(await call(fake, submit({ yaml: OLD, operation: 'test', slug: 'nope' })))).toContain('No monitor has the slug')
    expect(allText(await call(fake, submit({ yaml: OLD, operation: 'test', slug: '  ' })))).toContain('Enter the slug')
    const empty = createFakeContext()
    expect(allText(await call(empty, submit({ yaml: 'sites: [', operation: 'test', slug: 'a' })))).toContain('no valid configuration')
    expect(fake.bridgeCalls.filter(c => c === 'http.fetch')).toEqual([])
    expect(empty.bridgeCalls.filter(c => c === 'http.fetch')).toEqual([])
  })
})

describe('the dashboard widget (FR-12)', () => {
  const snapshot = (statuses: Record<string, 'up' | 'degraded' | 'down'>): ShardSnapshot => ({
    version: 2,
    shard: 0,
    updatedAt: '2026-10-22T10:00:00.000Z',
    deliveries: [],
    monitors: Object.entries(statuses).map(([slug, status]) => ({
      slug,
      result: { slug, status, code: status === 'down' ? 503 : 200, responseTime: 20, checkedAt: '2026-10-22T10:00:00.000Z' },
      days: [],
      totals: {},
    })),
  })
  const widget = { type: 'page_load', page: 'widget:status' }

  it('shows the overall status and a count per severity with at most two bridge calls', async () => {
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b', 'c', 'd']) })
    fake.kv.set('snapshot:0', snapshot({ a: 'up', b: 'up', c: 'degraded', d: 'down' }))
    const response = await call(fake, widget)
    expectValid(response)
    expect(fake.bridgeCalls.length).toBeLessThanOrEqual(2)
    expect(fake.bridgeCalls.filter(c => WRITE_CALLS.test(c))).toEqual([])
    expect(response.blocks[0]).toMatchObject({ type: 'banner', variant: 'error', title: 'Overall: Major outage', description: '4 monitors' })
    expect(response.blocks[1]).toEqual({
      type: 'stats',
      items: [{ label: 'Operational', value: 2 }, { label: 'Degraded', value: 1 }, { label: 'Major outage', value: 1 }],
    })
  })

  it('counts monitors with no result yet as not checked, never as an outage', async () => {
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b', 'c', 'd']) })
    const snap = snapshot({ a: 'up', b: 'up' })
    snap.monitors.push({ slug: 'c', result: null, days: [], totals: {}, warning: { limit: 'body', since: '2026-10-22T10:00:00.000Z', lastSeen: '2026-10-22T10:00:00.000Z' } })
    fake.kv.set('snapshot:0', snap)
    const response = await call(fake, widget)
    expectValid(response)
    expect(response.blocks[0]).toMatchObject({ type: 'banner', variant: 'default', title: 'Overall: Operational', description: '4 monitors' })
    expect(response.blocks[1]).toEqual({
      type: 'stats',
      items: [{ label: 'Operational', value: 2 }, { label: 'Degraded', value: 0 }, { label: 'Major outage', value: 0 }, { label: 'Not checked yet', value: 2 }],
    })

    const none = createFakeContext({ config: monitorsYaml(['a', 'b']) })
    none.kv.set('snapshot:0', { ...snapshot({}), updatedAt: '2026-10-22T10:00:00.000Z' })
    const unchecked = await call(none, widget)
    expect(unchecked.blocks[0]).toMatchObject({ variant: 'default', title: 'Overall: Not checked yet', description: '2 monitors' })
    expect(allText(unchecked)).not.toContain('"label":"Major outage","value":1')
  })

  it('shows an operational overall status when every monitor is up', async () => {
    const fake = createFakeContext({ config: monitorsYaml(['a', 'b']) })
    fake.kv.set('snapshot:0', snapshot({ a: 'up', b: 'up' }))
    const response = await call(fake, widget)
    expect(response.blocks[0]).toMatchObject({ variant: 'default', title: 'Overall: Operational' })
  })

  it('says so before the first check and without a configuration, instead of reporting an outage', async () => {
    const waiting = await call(createFakeContext({ config: OLD }), widget)
    expect(allText(waiting)).toContain('Waiting for the first check')
    const none = await call(createFakeContext(), widget)
    expect(allText(none)).toContain('No valid configuration')
    expectValid(none)
  })
})
