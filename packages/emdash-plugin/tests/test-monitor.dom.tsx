import type { TestResponse } from '../src/routes/admin'
import { getDict } from '@statusbeam/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Component tests for "Test this monitor" (FR-9, AC-015, AC-019). `apiFetch`
 * answers from an in-test server that records every request; the server half
 * (nothing recorded, no notification) is proven by the `admin/test` host tests.
 */

interface Recorded { method: string, url: string, body: unknown }

const server = {
  requests: [] as Recorded[],
  test: ((): Promise<TestResponse> | TestResponse => ({ tested: false, reason: 'not-found', message: 'unset' })) as (body: { monitor: Record<string, unknown> }) => Promise<TestResponse> | TestResponse,
}

async function fakeApiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  server.requests.push({ method: init?.method ?? 'GET', url, body })
  const route = url.replace('/_emdash/api/plugins/statusbeam/', '')
  if (route === 'admin/config') {
    return Response.json({ success: true, data: { revision: 'r1', config: { name: 'Acme', sites: [{ name: 'API', url: 'https://api.example.com' }, { name: 'Web', url: 'https://www.example.com' }] }, secretsSet: { slackWebhookUrl: false, webhookUrls: false, webhookSecret: false, sentryToken: false }, issues: [] } })
  }
  if (route === 'admin/test') {
    return Response.json({ success: true, data: await server.test(body) })
  }
  return Response.json({ success: false, error: { code: 'NOT_FOUND', message: `no route ${route}` } }, { status: 404 })
}

let MonitorsPage: typeof import('../src/admin/MonitorsPage').MonitorsPage

beforeAll(async () => {
  const real = await import('@emdash-cms/admin')
  mock.module('@emdash-cms/admin', () => ({
    ...real,
    apiFetch: fakeApiFetch,
    useCurrentUser: () => ({ isPending: false, isError: false, data: { id: 'u1', email: 'a@example.com', role: 50 } }),
  }))
  ;({ MonitorsPage } = await import('../src/admin/MonitorsPage'))
})

beforeEach(() => {
  server.requests = []
  document.documentElement.setAttribute('lang', 'en')
  document.documentElement.setAttribute('dir', 'ltr')
})

afterEach(() => {
  cleanup()
})

const dict = getDict('en')
const t = dict.admin.monitors.test
const posts = () => server.requests.filter(request => request.method === 'POST')
const card = (name: string) => screen.getByRole('region', { name })
const testButton = (name: string) => within(card(name)).getByRole('button', { name: t.action }) as HTMLButtonElement
const result = (name: string) => within(card(name)).getByText((_, element) => element?.getAttribute('aria-live') === 'polite')

async function openPage() {
  render(<MonitorsPage />)
  await screen.findByRole('heading', { level: 1 })
}

function checkResult(overrides: Partial<Extract<TestResponse, { tested: true }>['result']>): TestResponse {
  return { tested: true, result: { slug: 'api', status: 'up', code: 200, responseTime: 123, checkedAt: '2026-10-27T00:00:00.000Z', ...overrides } }
}

describe('test one monitor (AC-015)', () => {
  it('shows the status, response time and response code of an up monitor', async () => {
    server.test = () => checkResult({ status: 'up', code: 200, responseTime: 123 })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toContain(dict.day.up))
    const text = result('API').textContent
    expect(text).toContain(`${t.responseTime}123 ${dict.unit.ms}`)
    expect(text).toContain(`${t.responseCode}200`)
    expect(within(card('Web')).queryByText(dict.day.up)).toBeNull()
  })

  it('shows a down monitor with no response code and the error', async () => {
    server.test = () => checkResult({ status: 'down', code: 0, responseTime: 5, error: 'connection refused' })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toContain(dict.day.down))
    expect(result('API').textContent).toContain(`${t.responseCode}${t.noResponse}`)
    expect(result('API').textContent).toContain('connection refused')
  })

  it('tests the unsaved edit, sends one admin/test request and never saves', async () => {
    server.test = () => checkResult({})
    await openPage()
    fireEvent.change(within(card('API')).getByLabelText(dict.admin.monitors.field.url), { target: { value: 'http://127.0.0.1:9' } })
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toContain(dict.day.up))
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.url).toBe('/_emdash/api/plugins/statusbeam/admin/test')
    expect(posts()[0]!.body).toMatchObject({ monitor: { name: 'API', url: 'http://127.0.0.1:9' } })
    expect(server.requests.some(request => request.url.endsWith('admin/save'))).toBe(false)
  })

  it('shows the reason a monitor cannot be tested', async () => {
    server.test = () => ({ tested: false, reason: 'invalid', message: 'url: not a valid URL', issues: [] })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toBe('url: not a valid URL'))
    server.test = () => ({ tested: false, reason: 'no-token', message: 'Set the Sentry token first.' })
    fireEvent.click(testButton('Web'))
    await waitFor(() => expect(result('Web').textContent).toBe('Set the Sentry token first.'))
  })

  it('lists the field issues of an invalid monitor under the message', async () => {
    server.test = () => ({ tested: false, reason: 'invalid', message: 'The monitor is not valid.', issues: [{ severity: 'error', path: 'sentry.org', message: 'org is required' }, { severity: 'error', path: 'url', message: 'not a valid URL' }] })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(within(card('API')).getAllByRole('listitem')).toHaveLength(2))
    const items = within(card('API')).getAllByRole('listitem').map(item => item.textContent)
    expect(items).toEqual(['sentry.org: org is required', 'url: not a valid URL'])
    expect(result('API').textContent).toContain('The monitor is not valid.')
  })

  it('clears the previous outcome when the monitor is edited', async () => {
    server.test = () => checkResult({ status: 'up' })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toContain(dict.day.up))
    fireEvent.change(within(card('API')).getByLabelText(dict.admin.monitors.field.url), { target: { value: 'https://changed.example.com' } })
    await waitFor(() => expect(result('API').textContent).toBe(''))
  })

  it('clears the outcome when a numeric input becomes invalid and the sent monitor does not change', async () => {
    server.test = () => checkResult({ status: 'up' })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toContain(dict.day.up))
    fireEvent.change(within(card('API')).getByLabelText(dict.admin.monitors.field.maxResponseTime), { target: { value: 'abc' } })
    await waitFor(() => expect(result('API').textContent).toBe(''))
  })

  it('shows a failure when the test request itself fails', async () => {
    server.test = () => {
      throw new Error('boom')
    }
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toBe(t.failed))
  })

  it('disables the button while the test runs and re-enables it afterwards', async () => {
    let release: (value: TestResponse) => void = () => {}
    server.test = () => new Promise<TestResponse>((resolve) => {
      release = resolve
    })
    await openPage()
    fireEvent.click(testButton('API'))
    const running = within(card('API')).getByRole('button', { name: t.running }) as HTMLButtonElement
    expect(running.disabled).toBe(true)
    fireEvent.click(running)
    release(checkResult({}))
    await waitFor(() => expect(testButton('API').disabled).toBe(false))
    expect(posts()).toHaveLength(1)
  })

  it('announces the result in a polite live region', async () => {
    await openPage()
    const region = within(card('API')).getAllByText((_, element) => element?.getAttribute('aria-live') === 'polite')
    expect(region).toHaveLength(1)
  })
})

describe('stale, unsupported and invalid tests', () => {
  it('discards a response that arrives after the monitor was edited', async () => {
    let release: (value: TestResponse) => void = () => {}
    server.test = () => new Promise<TestResponse>((resolve) => {
      release = resolve
    })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(posts()).toHaveLength(1))
    fireEvent.change(within(card('API')).getByLabelText(dict.admin.monitors.field.url), { target: { value: 'https://changed.example.com' } })
    release(checkResult({ status: 'up' }))
    await waitFor(() => expect(testButton('API').disabled).toBe(false))
    expect(result('API').textContent).toBe('')
  })

  it('shows a body-limit result as unsupported, not down', async () => {
    server.test = () => checkResult({ status: 'down', code: 0, limit: 'body' })
    await openPage()
    fireEvent.click(testButton('API'))
    await waitFor(() => expect(result('API').textContent).toBe(t.unsupported))
    expect(result('API').textContent).not.toContain(dict.day.down)
  })

  it('disables Test while the expected status codes are not numbers', async () => {
    await openPage()
    fireEvent.change(within(card('API')).getByLabelText(dict.admin.monitors.field.expectedStatusCodes), { target: { value: '503x' } })
    expect(testButton('API').disabled).toBe(true)
  })
})
