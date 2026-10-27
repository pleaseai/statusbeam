import type { ConfigResponse, SaveResponse, SecretsSet } from '../src/routes/admin'
import { readFileSync } from 'node:fs'
import { getDict, LOCALES } from '@statusbeam/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Component tests for the monitors page. The two host hooks are mocked:
 * `apiFetch` answers from an in-test server that records every request, and
 * `useCurrentUser` returns the role under test. The module is spread from the
 * real one because `mock.module` replaces it for every later test file too.
 */

interface Recorded { method: string, url: string, headers: Headers, body: unknown }

const NO_SECRETS: SecretsSet = { slackWebhookUrl: false, webhookUrls: false, webhookSecret: false, sentryToken: false }

const server = {
  requests: [] as Recorded[],
  config: { revision: 'r1', config: null, secretsSet: NO_SECRETS, issues: [] } as ConfigResponse,
  save: ((): SaveResponse => ({ saved: false, reason: 'invalid', issues: [] })) as (body: { config: Record<string, unknown>, revision: string | null }) => SaveResponse,
}

const user: { role: number } = { role: 50 }

async function fakeApiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const headers = new Headers(init?.headers)
  headers.set('X-EmDash-Request', '1')
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  server.requests.push({ method: init?.method ?? 'GET', url, headers, body })
  const route = url.replace('/_emdash/api/plugins/statusbeam/', '')
  const data = route === 'admin/config' ? server.config : route === 'admin/save' ? server.save(body) : null
  if (data === null) {
    return Response.json({ success: false, error: { code: 'NOT_FOUND', message: `no route ${route}` } }, { status: 404 })
  }
  return Response.json({ success: true, data })
}

let MonitorsPage: typeof import('../src/admin/MonitorsPage').MonitorsPage

beforeAll(async () => {
  const real = await import('@emdash-cms/admin')
  mock.module('@emdash-cms/admin', () => ({
    ...real,
    apiFetch: fakeApiFetch,
    useCurrentUser: () => ({ isPending: false, isError: false, data: { id: 'u1', email: 'a@example.com', role: user.role } }),
  }))
  ;({ MonitorsPage } = await import('../src/admin/MonitorsPage'))
})

beforeEach(() => {
  server.requests = []
  server.config = { revision: 'r1', config: null, secretsSet: NO_SECRETS, issues: [] }
  server.save = () => ({ saved: false, reason: 'invalid', issues: [] })
  user.role = 50
  document.documentElement.setAttribute('lang', 'en')
  document.documentElement.setAttribute('dir', 'ltr')
})

afterEach(() => {
  cleanup()
})

const en = getDict('en').admin

const TWO_MONITORS = {
  name: 'Acme',
  sites: [
    { name: 'API', url: 'https://api.example.com' },
    { name: 'Website', url: 'https://www.example.com', expectedStatusCodes: [200, 301] },
  ],
}

function withConfig(config: Record<string, unknown> | null, extra: Partial<ConfigResponse> = {}) {
  server.config = { ...server.config, config, ...extra }
}

async function openPage() {
  const view = render(<MonitorsPage />)
  await screen.findByRole('heading', { level: 1 })
  return view
}

const card = (name: string) => screen.getByRole('region', { name })
const field = (name: string, label: string) => within(card(name)).getByLabelText(label) as HTMLInputElement
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } })
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const posts = () => server.requests.filter(request => request.method === 'POST')

/** The text an input points to with `aria-describedby`: its error or hint. */
function describedBy(input: HTMLElement): string {
  return (input.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
}

describe('editing monitors (AC-011)', () => {
  it('warns when the config is saved but the check schedule could not be updated', async () => {
    withConfig(TWO_MONITORS)
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null, scheduleError: 'cron unavailable' })
    await openPage()

    click(en.monitors.save)

    await screen.findByText(en.monitors.savedScheduleFailed('cron unavailable'))
    expect(screen.queryByText(en.monitors.saved)).toBeNull()
  })

  it('adds, edits and removes monitors and saves them with the loaded revision', async () => {
    withConfig(TWO_MONITORS)
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null })
    await openPage()

    type(field('API', en.monitors.field.url), 'https://api.example.com/health')
    click(en.monitors.remove('Website'))
    click(en.monitors.add)
    const added = screen.getByRole('region', { name: en.monitors.monitorN(2) })
    type(within(added).getByLabelText(en.monitors.field.name), 'Docs')
    type(within(added).getByLabelText(en.monitors.field.url), 'https://docs.example.com')
    click(en.monitors.save)

    await screen.findByText(en.monitors.saved)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.url).toBe('/_emdash/api/plugins/statusbeam/admin/save')
    expect(posts()[0]!.body).toEqual({
      revision: 'r1',
      config: {
        name: 'Acme',
        sites: [
          { name: 'API', url: 'https://api.example.com/health' },
          { name: 'Docs', url: 'https://docs.example.com', check: 'http' },
        ],
      },
    })
    expect(screen.queryByRole('region', { name: 'Website' })).toBeNull()
  })

  it('sends the host CSRF header on every request, GET included', async () => {
    withConfig(TWO_MONITORS)
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null })
    await openPage()
    click(en.monitors.save)
    await screen.findByText(en.monitors.saved)
    expect(server.requests.map(request => request.method)).toEqual(['GET', 'POST'])
    expect(server.requests.every(request => request.headers.get('X-EmDash-Request') === '1')).toBe(true)
  })

  it('keeps settings it has no field for when it saves', async () => {
    withConfig({ name: 'Acme', theme: { darkMode: false }, sites: [{ name: 'Errors', check: 'sentry', url: 'https://sentry.io', sentry: { org: 'acme' } }] })
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null })
    await openPage()
    expect(screen.getByText(en.monitors.keepsOtherSettings)).toBeTruthy()
    click(en.monitors.save)
    await screen.findByText(en.monitors.saved)
    expect(posts()[0]!.body).toMatchObject({ config: { theme: { darkMode: false }, sites: [{ sentry: { org: 'acme' } }] } })
  })

  it('offers the first monitor when nothing is stored', async () => {
    await openPage()
    expect(screen.getByText(en.monitors.empty)).toBeTruthy()
    expect(server.requests).toHaveLength(1)
  })

  it('changes the check type through the select', async () => {
    withConfig(TWO_MONITORS)
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null })
    await openPage()
    const trigger = within(card('API')).getByRole('combobox', { name: en.monitors.field.check })
    fireEvent.click(trigger)
    const option = await screen.findByRole('option', { name: 'tcp' })
    fireEvent.pointerDown(option)
    fireEvent.pointerUp(option)
    fireEvent.mouseUp(option)
    fireEvent.click(option)
    click(en.monitors.save)
    await screen.findByText(en.monitors.saved)
    expect(posts()[0]!.body).toMatchObject({ config: { sites: [{ name: 'API', check: 'tcp' }, { name: 'Website' }] } })
  })
})

describe('invalid fields (AC-011)', () => {
  it('shows the server error next to the url field and leaves the stored configuration unchanged', async () => {
    withConfig(TWO_MONITORS)
    server.save = () => ({ saved: false, reason: 'invalid', issues: [{ severity: 'error', path: 'sites[1].url', message: 'Invalid URL' }] })
    await openPage()

    type(field('Website', en.monitors.field.url), 'not a url')
    click(en.monitors.save)

    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('Website', en.monitors.field.url))).toContain('Invalid URL')
    expect(describedBy(field('API', en.monitors.field.url))).not.toContain('Invalid URL')
    expect(screen.queryByText(en.monitors.saved)).toBeNull()
    // The server refused; the editor made no second write and still holds the user's text.
    expect(posts()).toHaveLength(1)
    expect(field('Website', en.monitors.field.url).value).toBe('not a url')
  })

  it('does not carry a removed monitor\'s field error over to the monitor that takes its place', async () => {
    withConfig(TWO_MONITORS)
    server.save = () => ({ saved: false, reason: 'invalid', issues: [{ severity: 'error', path: 'sites[0].url', message: 'Invalid URL' }] })
    await openPage()
    click(en.monitors.save)
    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('API', en.monitors.field.url))).toContain('Invalid URL')

    click(en.monitors.remove('API'))

    expect(describedBy(field('Website', en.monitors.field.url))).not.toContain('Invalid URL')
  })

  it('shows a duplicate slug at the slug field before any save request', async () => {
    withConfig(TWO_MONITORS)
    await openPage()

    type(field('Website', en.monitors.field.slug), 'api')
    click(en.monitors.save)

    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('Website', en.monitors.field.slug))).toContain(en.monitors.duplicateSlug('api'))
    expect(describedBy(field('API', en.monitors.field.slug))).toContain(en.monitors.duplicateSlug('api'))
    expect(posts()).toHaveLength(0)
  })

  it('treats a slug derived from the name like a typed one', async () => {
    withConfig(TWO_MONITORS)
    await openPage()
    type(field('Website', en.monitors.field.name), 'api')
    click(en.monitors.save)
    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('api', en.monitors.field.slug))).toContain(en.monitors.duplicateSlug('api'))
    expect(posts()).toHaveLength(0)
  })

  it('shows a duplicate slug the server reports at the slug field too', async () => {
    withConfig(TWO_MONITORS)
    server.save = () => ({ saved: false, reason: 'invalid', issues: [{ severity: 'error', path: 'sites[1].slug', message: 'Duplicate slug "x"' }] })
    await openPage()
    type(field('Website', en.monitors.field.slug), 'website-2')
    click(en.monitors.save)
    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('Website', en.monitors.field.slug))).toContain('Duplicate slug')
  })

  it('refuses a status code list that is not numbers without asking the server', async () => {
    withConfig(TWO_MONITORS)
    await openPage()
    type(field('API', en.monitors.field.expectedStatusCodes), '200, ok')
    click(en.monitors.save)
    await screen.findByText(en.monitors.notSavedInvalid)
    expect(describedBy(field('API', en.monitors.field.expectedStatusCodes))).toContain(en.monitors.wholeNumbers)
    expect(posts()).toHaveLength(0)
  })

  it('lists warnings and errors without a field of their own', async () => {
    withConfig(TWO_MONITORS, { issues: [
      { severity: 'warning', path: 'sites[0].slug', message: 'Slug is long' },
      { severity: 'error', path: 'sites[0].sentry.org', message: 'org is required' },
    ] })
    await openPage()
    const list = screen.getByRole('region', { name: en.monitors.otherFindings })
    expect(within(list).getByText(/Slug is long/)).toBeTruthy()
    expect(within(list).getByText(/org is required/)).toBeTruthy()
  })
})

describe('renaming a slug (AC-011)', () => {
  it('says a renamed monitor is saved as a new one, and sends the new slug', async () => {
    withConfig({ name: 'Acme', sites: [{ name: 'API', slug: 'api', url: 'https://api.example.com' }] })
    server.save = body => ({ saved: true, revision: 'r2', config: body.config, issues: [], schedule: null })
    await openPage()
    expect(screen.queryByRole('note')).toBeNull()

    type(field('API', en.monitors.field.slug), 'api-v2')
    expect(within(card('API')).getByRole('note').textContent).toBe(en.monitors.slugRenamed('api'))

    click(en.monitors.save)
    await screen.findByText(en.monitors.saved)
    expect(posts()[0]!.body).toMatchObject({ config: { sites: [{ slug: 'api-v2' }] } })
    // Once saved, the new slug is the monitor's identity and the note goes away.
    expect(screen.queryByRole('note')).toBeNull()
    type(field('API', en.monitors.field.slug), 'api-v3')
    expect(within(card('API')).getByRole('note').textContent).toBe(en.monitors.slugRenamed('api-v2'))
  })

  it('does not call a newly added monitor a rename', async () => {
    await openPage()
    click(en.monitors.add)
    type(screen.getByLabelText(en.monitors.field.slug), 'fresh')
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('a stale save (AC-011)', () => {
  it('shows the newer configuration and says the edit was not saved', async () => {
    withConfig(TWO_MONITORS)
    const newer = { name: 'Acme', sites: [{ name: 'Newer monitor', url: 'https://new.example.com' }] }
    server.save = () => ({ saved: false, reason: 'stale', config: newer, revision: 'r9', secretsSet: { ...NO_SECRETS, sentryToken: true }, issues: [] })
    await openPage()

    type(field('API', en.monitors.field.name), 'My edit')
    click(en.monitors.save)

    await screen.findByText(en.monitors.notSavedStale)
    expect(screen.queryByRole('region', { name: 'My edit' })).toBeNull()
    expect(field('Newer monitor', en.monitors.field.url).value).toBe('https://new.example.com')
    expect(screen.queryByText(en.monitors.saved)).toBeNull()

    // The next save carries the newer revision.
    server.save = body => ({ saved: true, revision: 'r10', config: body.config, issues: [], schedule: null })
    click(en.monitors.save)
    await screen.findByText(en.monitors.saved)
    expect(posts()[1]!.body).toMatchObject({ revision: 'r9' })
  })
})

describe('secrets (AC-010)', () => {
  it('shows only set or not set for each secret, with a link to the plugin settings page', async () => {
    withConfig(TWO_MONITORS, { secretsSet: { slackWebhookUrl: true, webhookUrls: false, webhookSecret: true, sentryToken: false } })
    await openPage()

    const secrets = screen.getByRole('region', { name: en.secrets.heading })
    const value = (label: string) => within(secrets).getByText(label).closest('div')!.querySelector('dd')!.textContent
    expect(value(en.secrets.slackWebhookUrl)).toBe(en.secrets.set)
    expect(value(en.secrets.webhookUrls)).toBe(en.secrets.notSet)
    expect(value(en.secrets.webhookSecret)).toBe(en.secrets.set)
    expect(value(en.secrets.sentryToken)).toBe(en.secrets.notSet)
    expect(within(secrets).getByRole('link', { name: en.secrets.manage }).getAttribute('href')).toBe('/_emdash/admin/plugins-manager/statusbeam/settings')
    // The page never asks for a secret value: the only request is the configuration.
    expect(server.requests.map(request => request.url)).toEqual(['/_emdash/api/plugins/statusbeam/admin/config'])
    expect(secrets.querySelector('input')).toBeNull()
  })
})

describe('who may see the editor (AC-016)', () => {
  it.each([10, 30, 40])('refuses a user with role %i and never requests the configuration', async (role) => {
    user.role = role
    withConfig(TWO_MONITORS)
    render(<MonitorsPage />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.forbidden)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests).toHaveLength(0)
    expect(screen.queryByText('API')).toBeNull()
    expect(document.querySelectorAll('input')).toHaveLength(0)
  })

  it('shows an administrator the editor', async () => {
    user.role = 50
    withConfig(TWO_MONITORS)
    await openPage()
    expect(screen.getByRole('region', { name: 'API' })).toBeTruthy()
  })
})

describe('text and direction (NFR-1)', () => {
  it.each([...LOCALES])('shows %s text from core\'s dictionary', async (locale) => {
    document.documentElement.setAttribute('lang', locale)
    withConfig(TWO_MONITORS)
    await openPage()
    const t = getDict(locale).admin
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t.monitors.title)
    expect(screen.getByRole('button', { name: t.monitors.add })).toBeTruthy()
    expect(screen.getByRole('button', { name: t.monitors.save })).toBeTruthy()
    expect(screen.getByRole('region', { name: t.secrets.heading })).toBeTruthy()
    expect(within(card('API')).getByLabelText(t.monitors.field.url)).toBeTruthy()
  })

  it('has different text per locale, so the cases above prove a translation', () => {
    expect(new Set(LOCALES.map(locale => getDict(locale).admin.monitors.title)).size).toBe(LOCALES.length)
  })

  it('maps a regional tag to its language', async () => {
    document.documentElement.setAttribute('lang', 'ko-KR')
    await openPage()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(getDict('ko').admin.monitors.title)
  })

  it.each(['ar', 'fr', ''])('falls back to English for the admin locale "%s"', async (lang) => {
    document.documentElement.setAttribute('lang', lang)
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr')
    withConfig(TWO_MONITORS)
    await openPage()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en.monitors.title)
    expect(screen.getByRole('button', { name: en.monitors.add })).toBeTruthy()
  })

  it('follows a locale switch without reloading the configuration', async () => {
    withConfig(TWO_MONITORS)
    await openPage()
    document.documentElement.setAttribute('lang', 'ja')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(getDict('ja').admin.monitors.title))
    expect(server.requests).toHaveLength(1)
  })

  it('lays out with logical properties only, and keeps URLs left to right inside an RTL page', async () => {
    document.documentElement.setAttribute('lang', 'ar')
    document.documentElement.setAttribute('dir', 'rtl')
    withConfig(TWO_MONITORS)
    const view = await openPage()

    const physical = /^(?:[\w-]+:)*(?:ml|mr|pl|pr|left|right|float-left|float-right|text-left|text-right|rounded-[lr]|rounded-[tb][lr]|border-[lr]|space-x-reverse|divide-x)(?:-|$)/
    const used = new Set<string>()
    for (const element of view.container.querySelectorAll('[class]')) {
      for (const name of element.getAttribute('class')!.split(/\s+/).filter(Boolean)) {
        used.add(name)
      }
    }
    expect([...used].filter(name => physical.test(name))).toEqual([])
    expect(field('API', en.monitors.field.url).getAttribute('dir')).toBe('ltr')
    expect(field('API', en.monitors.field.slug).getAttribute('dir')).toBe('ltr')
    // Rendered under the page's own direction: nothing sets `dir` on the form itself.
    expect(view.container.querySelector('form')!.getAttribute('dir')).toBeNull()
  })

  it('uses only classes the admin\'s precompiled stylesheet defines', () => {
    const css = readFileSync(require.resolve('@emdash-cms/admin/styles.css'), 'utf8')
    const escaped = (name: string) => `.${name.replace(/([^\w-])/g, '\\$1')}`
    const missing = new Set<string>()
    for (const file of ['MonitorsPage.tsx', 'AdminGate.tsx', 'index.tsx', 'MonitorActions.tsx', 'TestMonitor.tsx', 'StatusPage.tsx', 'StatusWidget.tsx']) {
      const source = readFileSync(new URL(`../src/admin/${file}`, import.meta.url), 'utf8')
      for (const match of source.matchAll(/className=(?:"([^"]+)"|\{([^}]*)\})/g)) {
        const names = match[1] ? [match[1]] : [...(match[2] ?? '').matchAll(/[?:]\s*'([^']+)'/g)].map(literal => literal[1]!)
        for (const name of names.flatMap(group => group.split(/\s+/))) {
          if (name !== '' && !css.includes(escaped(name))) {
            missing.add(name)
          }
        }
      }
    }
    expect([...missing]).toEqual([])
  })
})
