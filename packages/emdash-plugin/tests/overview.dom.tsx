import type { OverviewResponse } from '../src/routes/admin'
import { getDict } from '@statusbeam/core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Component tests for the status overview page and the dashboard widget (FR-8,
 * FR-10, NFR-1, AC-014, AC-016). `apiFetch` answers from an in-test server that
 * records every request; the `admin/overview` route itself is proven by the
 * host tests.
 */

interface Recorded { method: string, url: string }

const server = { requests: [] as Recorded[], overview: undefined as unknown as OverviewResponse, failing: false }
const user = { role: 50 }

function fakeApiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  server.requests.push({ method: init?.method ?? 'GET', url })
  const route = url.replace('/_emdash/api/plugins/statusbeam/', '')
  if (route === 'admin/overview') {
    return Promise.resolve(server.failing
      ? Response.json({ success: false, error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 })
      : Response.json({ success: true, data: server.overview }))
  }
  return Promise.resolve(Response.json({ success: false, error: { code: 'NOT_FOUND', message: `no route ${route}` } }, { status: 404 }))
}

let StatusPage: typeof import('../src/admin/StatusPage').StatusPage
let StatusWidget: typeof import('../src/admin/StatusWidget').StatusWidget
let admin: typeof import('../src/admin/index')

beforeAll(async () => {
  const real = await import('@emdash-cms/admin')
  await mock.module('@emdash-cms/admin', () => ({
    ...real,
    apiFetch: fakeApiFetch,
    useCurrentUser: () => ({ isPending: false, isError: false, data: { id: 'u1', email: 'a@example.com', role: user.role } }),
  }))
  ;({ StatusPage } = await import('../src/admin/StatusPage'))
  ;({ StatusWidget } = await import('../src/admin/StatusWidget'))
  admin = await import('../src/admin/index')
})

type Monitor = OverviewResponse['monitors'][number]

function days(statuses: Array<'up' | 'degraded' | 'down' | null>): Monitor['history'] {
  return statuses.map((status, i) => ({
    date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
    status,
    uptime: status === 'up' ? 1 : status === 'degraded' ? 0.9 : status === 'down' ? 0 : 1,
  }))
}

function monitor(overrides: Partial<Monitor> & Pick<Monitor, 'slug' | 'name'>): Monitor {
  return { status: 'up', responseTime: 120, uptimeDay: '100%', uptimeWeek: '100%', uptimeMonth: '100%', history: days(Array.from<'up'>({ length: 90 }).fill('up')), ...overrides }
}

function pendingMonitor(slug: string, name: string): Monitor {
  return monitor({ slug, name, status: 'down', pending: true, responseTime: 0, history: days(Array.from<null>({ length: 90 }).fill(null)) })
}

function ready(monitors: Monitor[], status: OverviewResponse['status'] = 'operational'): OverviewResponse {
  return { configured: true, configIssues: [], updatedAt: '2026-10-27T00:00:00.000Z', status, monitors }
}

beforeEach(() => {
  server.requests = []
  server.failing = false
  user.role = 50
  server.overview = ready([])
  document.documentElement.setAttribute('lang', 'en')
  document.documentElement.setAttribute('dir', 'ltr')
})

afterEach(() => {
  cleanup()
})

const dict = getDict('en')
const card = (name: string) => screen.getByRole('region', { name })

describe('status overview page (AC-014)', () => {
  it('lists every monitor with its status, 90 bars and latest latency', async () => {
    server.overview = ready([
      monitor({ slug: 'api', name: 'API', status: 'up', responseTime: 123, history: days(Array.from<'up'>({ length: 90 }).fill('up')) }),
      monitor({ slug: 'web', name: 'Web', status: 'degraded', responseTime: 2500 }),
      monitor({ slug: 'db', name: 'DB', status: 'down', responseTime: 0 }),
    ], 'major_outage')
    render(<StatusPage />)
    await screen.findByRole('heading', { level: 1, name: dict.admin.overview.title })
    expect(screen.getAllByRole('region')).toHaveLength(3)
    expect(within(card('API')).getByText(dict.day.up, { selector: 'p' })).toBeTruthy()
    expect(within(card('Web')).getByText(dict.day.degraded, { selector: 'p' })).toBeTruthy()
    expect(within(card('DB')).getByText(dict.day.down, { selector: 'p' })).toBeTruthy()
    expect(within(card('API')).getByText(`123 ${dict.unit.ms}`)).toBeTruthy()
    expect(within(card('Web')).getByText(`2500 ${dict.unit.ms}`)).toBeTruthy()
    for (const name of ['API', 'Web', 'DB']) {
      expect(within(card(name)).getAllByRole('listitem')).toHaveLength(90)
    }
    expect(screen.getByText(dict.banner.major_outage)).toBeTruthy()
    expect(server.requests.map(request => request.url)).toEqual(['/_emdash/api/plugins/statusbeam/admin/overview'])
  })

  it('gives each bar a text alternative naming its day and status, and names the strip by its uptime', async () => {
    server.overview = ready([monitor({ slug: 'api', name: 'API', history: days(['up', 'degraded', 'down', null]) })])
    render(<StatusPage />)
    await screen.findByRole('region', { name: 'API' })
    const strip = within(card('API')).getByRole('list')
    const bars = within(strip).getAllByRole('listitem')
    expect(bars.map(bar => bar.getAttribute('data-day'))).toEqual(['up', 'degraded', 'down', 'nodata'])
    expect(bars[1]!.textContent).toContain(dict.day.degraded)
    expect(bars[2]!.textContent).toContain(dict.day.down)
    expect(bars[3]!.textContent).toContain(dict.day.nodata)
    expect(bars[0]!.getAttribute('title')).toBe(bars[0]!.textContent!)
    // The strip's name carries the 90-day uptime figure, and the bars differ by height as well as colour.
    expect(strip.getAttribute('aria-label')).toBe(dict.timeline.ariaUptime('63.33%'))
    expect(new Set(bars.map(bar => bar.className.split(' ').find(c => c.startsWith('h-')))).size).toBe(4)
  })

  it('reads "Not checked yet" for a never-checked monitor, with no uptime figure and no latency', async () => {
    server.overview = ready([monitor({ slug: 'api', name: 'API' }), pendingMonitor('new', 'New')])
    render(<StatusPage />)
    await screen.findByRole('region', { name: 'New' })
    const pending = card('New')
    expect(within(pending).getByText(dict.status.notChecked)).toBeTruthy()
    expect(within(pending).queryByText(dict.day.down)).toBeNull()
    expect(within(pending).queryByText(dict.admin.overview.uptime)).toBeNull()
    expect(within(pending).queryByText(dict.status.responseTime)).toBeNull()
    expect(pending.textContent).not.toMatch(/\d(?:\.\d+)?%/)
    expect(within(pending).getByRole('list').getAttribute('aria-label')).toBe(dict.timeline.ariaNoData)
    // The checked monitor beside it still shows its figure.
    expect(within(card('API')).getByText('100%', { selector: 'dd' })).toBeTruthy()
  })

  it('shows the stored configuration\'s findings instead of the empty state when the configuration is rejected', async () => {
    server.overview = { configured: false, configIssues: [{ severity: 'error', path: 'sites[0].url', message: 'Invalid URL' }], updatedAt: null, status: 'operational', monitors: [] }
    render(<StatusPage />)
    await screen.findByText('Invalid URL')
    expect(screen.getByRole('heading', { level: 2, name: dict.admin.overview.configIssues })).toBeTruthy()
    expect(screen.queryByText(dict.admin.overview.empty)).toBeNull()
    // The only region is the findings section; there is no monitor card.
    expect(screen.getAllByRole('region').map(region => region.querySelector('h2')?.textContent)).toEqual([dict.admin.overview.configIssues])
    expect(screen.queryByText(dict.banner.operational)).toBeNull()
  })

  it('reads "Waiting for the first check" instead of a banner while every monitor is pending', async () => {
    server.overview = ready([pendingMonitor('a', 'A'), pendingMonitor('b', 'B')])
    render(<StatusPage />)
    await screen.findByRole('region', { name: 'A' })
    expect(screen.getByRole('status').textContent).toBe(dict.admin.overview.waiting)
    expect(screen.queryByText(dict.banner.operational)).toBeNull()
  })

  it('keeps the banner when checked and pending monitors are mixed', async () => {
    server.overview = ready([monitor({ slug: 'a', name: 'A' }), pendingMonitor('b', 'B')])
    render(<StatusPage />)
    await screen.findByRole('region', { name: 'B' })
    expect(screen.getByRole('status').textContent).toBe(dict.banner.operational)
    expect(screen.queryByText(dict.admin.overview.waiting)).toBeNull()
  })

  it('links to the monitor editor', async () => {
    render(<StatusPage />)
    const link = await screen.findByRole('link', { name: dict.admin.overview.manage })
    expect(link.getAttribute('href')).toBe('/_emdash/admin/plugins/statusbeam/monitors')
  })

  it('reports a failed request', async () => {
    server.failing = true
    render(<StatusPage />)
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
  })
})

describe('dashboard widget (AC-016)', () => {
  it('summarizes an operational site', async () => {
    server.overview = ready([monitor({ slug: 'a', name: 'A' }), monitor({ slug: 'b', name: 'B' })])
    render(<StatusWidget />)
    await screen.findByText(dict.banner.operational)
    expect(screen.getByText(`2 ${dict.day.up}`)).toBeTruthy()
    expect(screen.getByRole('link', { name: dict.admin.overview.view }).getAttribute('href')).toBe('/_emdash/admin/plugins/statusbeam/')
  })

  it('summarizes degraded, outage and not-checked counts, and the worst status leads', async () => {
    server.overview = ready([
      monitor({ slug: 'a', name: 'A' }),
      monitor({ slug: 'b', name: 'B', status: 'degraded' }),
      monitor({ slug: 'c', name: 'C', status: 'down' }),
      pendingMonitor('d', 'D'),
      pendingMonitor('e', 'E'),
    ], 'major_outage')
    render(<StatusWidget />)
    await screen.findByText(dict.banner.major_outage)
    expect(screen.getByText(`1 ${dict.day.up} · 1 ${dict.day.degraded} · 1 ${dict.day.down} · 2 ${dict.status.notChecked}`)).toBeTruthy()
  })

  it('does not call a site with only never-checked monitors an outage', async () => {
    server.overview = ready([pendingMonitor('d', 'D')])
    render(<StatusWidget />)
    await screen.findByText(`1 ${dict.status.notChecked}`)
    expect(screen.queryByText(new RegExp(dict.banner.major_outage))).toBeNull()
    expect(screen.queryByText(`1 ${dict.day.down}`)).toBeNull()
  })

  it('reads "Waiting for the first check" instead of a banner while every monitor is pending', async () => {
    server.overview = ready([pendingMonitor('d', 'D'), pendingMonitor('e', 'E')])
    render(<StatusWidget />)
    await screen.findByText(`2 ${dict.status.notChecked}`)
    expect(screen.getByRole('status').textContent).toBe(dict.admin.overview.waiting)
    expect(screen.queryByText(dict.banner.operational)).toBeNull()
  })

  it('keeps the banner when checked and pending monitors are mixed', async () => {
    server.overview = ready([monitor({ slug: 'a', name: 'A' }), pendingMonitor('d', 'D')])
    render(<StatusWidget />)
    await screen.findByText(dict.banner.operational)
    expect(screen.queryByText(dict.admin.overview.waiting)).toBeNull()
  })

  it('shows the empty state with a link when no monitor is configured', async () => {
    render(<StatusWidget />)
    await screen.findByText(dict.admin.overview.empty)
    expect(screen.getByRole('link', { name: dict.admin.overview.view })).toBeTruthy()
  })

  it('reports a rejected stored configuration instead of the empty state', async () => {
    server.overview = { configured: false, configIssues: [{ severity: 'error', path: 'sites[0].url', message: 'Invalid URL' }], updatedAt: null, status: 'operational', monitors: [] }
    render(<StatusWidget />)
    expect((await screen.findByRole('alert')).textContent).toContain(dict.admin.overview.configIssues)
    expect(screen.queryByText(dict.admin.overview.empty)).toBeNull()
  })

  it('reports a failed request', async () => {
    server.failing = true
    render(<StatusWidget />)
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
  })
})

describe('both refuse non-administrators', () => {
  for (const role of [10, 30, 40]) {
    it(`role ${role}: refusal and zero requests`, async () => {
      user.role = role
      render(
        <>
          <StatusPage />
          <StatusWidget />
        </>,
      )
      await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
      for (const alert of screen.getAllByRole('alert')) {
        expect(alert.textContent).toContain(dict.admin.forbidden)
      }
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
      expect(server.requests).toEqual([])
    })
  }
})

describe('registration', () => {
  it('serves the overview at the root, the editor at /monitors and the widget as "status"', () => {
    expect(admin.pages['/']).toBe(StatusPage)
    expect(Object.keys(admin.pages)).toEqual(['/', '/monitors'])
    expect(admin.widgets.status).toBe(StatusWidget)
  })
})

describe('locale (NFR-1)', () => {
  for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
    it(`${locale}: the page and widget read the ${locale} dictionary`, async () => {
      document.documentElement.setAttribute('lang', locale)
      const d = getDict(locale)
      server.overview = ready([monitor({ slug: 'a', name: 'A', status: 'degraded' }), pendingMonitor('b', 'B')], 'degraded')
      render(
        <>
          <StatusPage />
          <StatusWidget />
        </>,
      )
      await screen.findByRole('heading', { level: 1, name: d.admin.overview.title })
      await waitFor(() => expect(screen.getAllByRole('status').map(status => status.textContent)).toEqual([d.banner.degraded, d.banner.degraded]))
      expect(within(card('A')).getByText(d.day.degraded, { selector: 'p' })).toBeTruthy()
      expect(within(card('B')).getByText(d.status.notChecked)).toBeTruthy()
      expect(screen.getByText(`1 ${d.day.degraded} · 1 ${d.status.notChecked}`)).toBeTruthy()
      expect(screen.getByRole('link', { name: d.admin.overview.view })).toBeTruthy()
    })
  }

  it('reads English for an unsupported admin locale', async () => {
    document.documentElement.setAttribute('lang', 'ar')
    render(<StatusPage />)
    await screen.findByRole('heading', { level: 1, name: dict.admin.overview.title })
  })
})
