import type { BlockResponse } from '@emdash-cms/blocks'
import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The admin page and widget through EmDash's production sandbox wrapper: the
 * host's own Block Kit validation, `settings.getVersioned`/`compareAndSet`, and
 * the route permission. Bridge-call budgets are asserted in `admin.test.ts`.
 */

let host: PluginRuntimeTestHost | undefined

afterEach(async () => {
  await host?.dispose()
  host = undefined
})

const PAGE = '/config'
const OLD = 'name: Old\nsites:\n  - name: alpha\n    url: https://alpha.example.com/\n'
const NEW = 'name: New\nsites:\n  - name: alpha\n    url: https://alpha.example.com/\n  - name: beta\n    url: https://beta.example.com/\n'

async function newHost(yaml: string) {
  host = await createPluginRuntimeTestHost()
  await host.fixtures.plugin.setting('config', yaml)
  const admin = await host.fixtures.user({ email: 'admin@example.com', role: 'admin' })
  const second = await host.fixtures.user({ email: 'second@example.com', role: 'admin' })
  const editor = await host.fixtures.user({ email: 'editor@example.com', role: 'editor' })
  return { host, admin, second, editor }
}

const text = (response: BlockResponse) => JSON.stringify(response.blocks)

/** The submit id of the response's configuration form, which carries the revision the form was rendered with. */
function runActionOf(response: BlockResponse): string {
  const form = response.blocks.find(block => block.type === 'form')
  if (!form || form.type !== 'form') {
    throw new Error('no form in the response')
  }
  return form.submit.action_id
}

describe('the admin page', () => {
  it('renders for an administrator and carries the stored YAML in one multiline field', async () => {
    const { host: h, admin } = await newHost(OLD)
    const page = await h.admin.loadPage(PAGE, { user: admin })
    const form = page.blocks.find(block => block.type === 'form')
    expect(form).toMatchObject({ type: 'form', submit: { action_id: expect.stringMatching(/^run:/) } })
    expect(JSON.stringify(form)).toContain('"multiline":true')
    expect(JSON.stringify(form)).toContain('name: Old')
  })

  it('refuses an editor on the page, the widget and every action at the host, before the plugin runs', async () => {
    const { host: h, editor } = await newHost(OLD)
    const attempts: Array<() => Promise<BlockResponse>> = [
      () => h.admin.loadPage(PAGE, { user: editor }),
      () => h.admin.loadWidget('status', { user: editor }),
      () => h.admin.submit(PAGE, 'run', { yaml: NEW, operation: 'save' }, { user: editor }),
      () => h.admin.submit(PAGE, 'run', { yaml: NEW, operation: 'validate' }, { user: editor }),
      () => h.admin.submit(PAGE, 'run', { yaml: NEW, operation: 'test', slug: 'alpha' }, { user: editor }),
      () => h.admin.act(PAGE, 'reload', { user: editor }),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/permission|forbidden|plugins:manage/i)
    }
    expect(await h.inspect.setting('config')).toBe(OLD)
    expect(await h.inspect.kv.list()).toEqual([])
  })

  it('shows every issue and keeps the stored configuration on an invalid save, then saves a valid one and refuses a stale one', async () => {
    const { host: h, admin, second } = await newHost(OLD)
    const adminForm = runActionOf(await h.admin.loadPage(PAGE, { user: admin }))
    const secondForm = runActionOf(await h.admin.loadPage(PAGE, { user: second }))

    const bad = await h.admin.submit(PAGE, adminForm, { yaml: 'name: X\nsites:\n  - name: a\n    url: nope\n', operation: 'save' }, { user: admin })
    expect(text(bad)).toContain('Error at sites[0].url')
    expect(await h.inspect.setting('config')).toBe(OLD)

    const saved = await h.admin.submit(PAGE, secondForm, { yaml: NEW, operation: 'save' }, { user: second })
    expect(saved.toast?.type).toBe('success')
    expect(await h.inspect.setting('config')).toBe(NEW)

    const stale = await h.admin.submit(PAGE, adminForm, { yaml: OLD.replace('Old', 'Mine'), operation: 'save' }, { user: admin })
    expect(text(stale)).toContain('Reload to see the current configuration')
    expect(await h.inspect.setting('config')).toBe(NEW)
  })

  it('refuses a save from an older tab of the same administrator after a newer tab saved', async () => {
    const { host: h, admin } = await newHost(OLD)
    const tab1 = runActionOf(await h.admin.loadPage(PAGE, { user: admin }))
    const tab2 = runActionOf(await h.admin.loadPage(PAGE, { user: admin }))

    const saved = await h.admin.submit(PAGE, tab2, { yaml: NEW, operation: 'save' }, { user: admin })
    expect(saved.toast?.type).toBe('success')
    const stale = await h.admin.submit(PAGE, tab1, { yaml: OLD.replace('Old', 'Mine'), operation: 'save' }, { user: admin })
    expect(text(stale)).toContain('Reload to see the current configuration')
    expect(await h.inspect.setting('config')).toBe(NEW)

    // The saved form and a reload both carry the current revision.
    const again = await h.admin.submit(PAGE, runActionOf(saved), { yaml: OLD, operation: 'save' }, { user: admin })
    expect(again.toast?.type).toBe('success')
    const reloaded = await h.admin.act(PAGE, 'reload', { user: admin })
    const fromReload = await h.admin.submit(PAGE, runActionOf(reloaded), { yaml: NEW, operation: 'save' }, { user: admin })
    expect(fromReload.toast?.type).toBe('success')
    expect(await h.inspect.setting('config')).toBe(NEW)
  })

  it('tests one monitor through ctx.http.fetch and writes no history', async () => {
    const { host: h, admin } = await newHost(OLD)
    await h.http.respond('https://alpha.example.com/', new Response('ok', { status: 200 }))
    const response = await h.admin.submit(PAGE, 'run', { yaml: OLD, operation: 'test', slug: 'alpha' }, { user: admin })
    expect(text(response)).toContain('"label":"Status","value":"up"')
    expect(h.http.requests().map(r => r.url)).toEqual(['https://alpha.example.com/'])
    expect(await h.inspect.storage.list('buckets')).toEqual([])
    expect(await h.inspect.kv.get('snapshot:0')).toBeNull()
  })
})

describe('the dashboard widget', () => {
  it('shows the overall status and the severity counts from the shard snapshot', async () => {
    const { host: h, admin } = await newHost(NEW)
    await h.http.respond('https://alpha.example.com/', new Response('ok', { status: 200 }))
    await h.http.respond('https://beta.example.com/', new Response('no', { status: 503 }))
    await h.transport.invokeHook('cron', { name: 'check-0', data: { shard: 0 }, scheduledAt: new Date().toISOString() })
    const widget = await h.admin.loadWidget('status', { user: admin })
    expect(text(widget)).toContain('Overall: Major outage')
    expect(JSON.stringify(widget.blocks.find(block => block.type === 'stats'))).toContain('{"label":"Operational","value":1}')
    expect(JSON.stringify(widget.blocks.find(block => block.type === 'stats'))).toContain('{"label":"Major outage","value":1}')
  })
})
