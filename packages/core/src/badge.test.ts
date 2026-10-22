import type { SiteSummary } from './types'
import { describe, expect, it } from 'bun:test'
import {
  overallBadge,
  parseUptimePercent,
  responseBadge,
  responseColor,
  severityColor,
  statusBadge,
  statusMessage,
  uptimeBadge,
  uptimeColor,
} from './badge'

function site(overrides: Partial<SiteSummary> = {}): SiteSummary {
  return {
    slug: 'api',
    name: 'API',
    status: 'up',
    responseTime: 142,
    uptimeDay: '100%',
    uptimeWeek: '99.98%',
    uptimeMonth: '99.90%',
    history: [],
    ...overrides,
  }
}

describe('severityColor', () => {
  it('maps each status to its badge color', () => {
    expect(severityColor('up')).toBe('brightgreen')
    expect(severityColor('degraded')).toBe('yellow')
    expect(severityColor('down')).toBe('red')
  })
})

describe('statusMessage', () => {
  it('reports the raw status word', () => {
    expect(statusMessage('up')).toBe('up')
    expect(statusMessage('degraded')).toBe('degraded')
    expect(statusMessage('down')).toBe('down')
  })
})

describe('uptimeColor', () => {
  it('greens for three nines, reds below 90%', () => {
    expect(uptimeColor(1)).toBe('brightgreen')
    expect(uptimeColor(0.999)).toBe('brightgreen')
    expect(uptimeColor(0.995)).toBe('green')
    expect(uptimeColor(0.97)).toBe('yellow')
    expect(uptimeColor(0.92)).toBe('orange')
    expect(uptimeColor(0.5)).toBe('red')
  })
})

describe('responseColor', () => {
  it('greens when fast, reds when slow (inverted scale)', () => {
    expect(responseColor(50)).toBe('brightgreen')
    expect(responseColor(400)).toBe('green')
    expect(responseColor(800)).toBe('yellowgreen')
    expect(responseColor(1500)).toBe('yellow')
    expect(responseColor(3000)).toBe('orange')
    expect(responseColor(9000)).toBe('red')
  })
})

describe('parseUptimePercent', () => {
  it('parses a formatted percentage back to a ratio', () => {
    expect(parseUptimePercent('99.98%')).toBeCloseTo(0.9998)
    expect(parseUptimePercent('100%')).toBe(1)
  })

  it('falls back to 1 for unparseable input', () => {
    expect(parseUptimePercent('n/a')).toBe(1)
  })
})

describe('statusBadge', () => {
  it('builds a shields endpoint from the site name and status', () => {
    expect(statusBadge(site({ name: 'API', status: 'degraded' }))).toEqual({
      schemaVersion: 1,
      label: 'API',
      message: 'degraded',
      color: 'yellow',
    })
  })
})

describe('overallBadge', () => {
  it('is operational and green when everything is up', () => {
    expect(overallBadge([site({ status: 'up' }), site({ status: 'up' })])).toEqual({
      schemaVersion: 1,
      label: 'status',
      message: 'operational',
      color: 'brightgreen',
    })
  })

  it('reports the worst status (down wins)', () => {
    const badge = overallBadge([site({ status: 'up' }), site({ status: 'degraded' }), site({ status: 'down' })])
    expect(badge.message).toBe('major outage')
    expect(badge.color).toBe('red')
  })

  it('degrades to green for an empty summary', () => {
    expect(overallBadge([])).toEqual({
      schemaVersion: 1,
      label: 'status',
      message: 'operational',
      color: 'brightgreen',
    })
  })
})

describe('uptimeBadge', () => {
  it('defaults to the monthly window', () => {
    expect(uptimeBadge(site({ uptimeMonth: '99.50%' }))).toEqual({
      schemaVersion: 1,
      label: 'uptime',
      message: '99.50%',
      color: 'green',
    })
  })

  it('selects the requested period', () => {
    const s = site({ uptimeDay: '100%', uptimeWeek: '95.00%' })
    expect(uptimeBadge(s, 'day').message).toBe('100%')
    expect(uptimeBadge(s, 'day').color).toBe('brightgreen')
    expect(uptimeBadge(s, 'week').color).toBe('yellow')
  })

  it('falls back to "n/a" for a snapshot missing the field (KV bypasses the type check)', () => {
    const s = site({ uptimeMonth: undefined as unknown as string })
    expect(uptimeBadge(s, 'month').message).toBe('n/a')
  })
})

describe('responseBadge', () => {
  it('reports the response time in ms with a speed-scaled color', () => {
    expect(responseBadge(site({ responseTime: 142 }))).toEqual({
      schemaVersion: 1,
      label: 'response time',
      message: '142ms',
      color: 'brightgreen',
    })
  })

  it('reports "down" instead of "0ms" when the site is down', () => {
    expect(responseBadge(site({ status: 'down', responseTime: 0 }))).toEqual({
      schemaVersion: 1,
      label: 'response time',
      message: 'down',
      color: 'red',
    })
  })
})

describe('badges for a site not checked yet', () => {
  const pending = site({ status: 'down', pending: true, responseTime: 0 })

  it('report "not checked" in grey instead of an outage', () => {
    expect(statusBadge(pending)).toEqual({ schemaVersion: 1, label: 'API', message: 'not checked', color: 'lightgrey' })
    expect(responseBadge(pending)).toEqual({ schemaVersion: 1, label: 'response time', message: 'not checked', color: 'lightgrey' })
    expect(uptimeBadge(pending, 'week')).toEqual({ schemaVersion: 1, label: 'uptime', message: 'not checked', color: 'lightgrey' })
  })

  it('leave the site out of the overall badge', () => {
    expect(overallBadge([site(), pending])).toEqual({ schemaVersion: 1, label: 'status', message: 'operational', color: 'brightgreen' })
    expect(overallBadge([pending])).toMatchObject({ message: 'operational', color: 'brightgreen' })
    expect(overallBadge([pending, site({ status: 'degraded' })])).toMatchObject({ message: 'degraded', color: 'yellow' })
  })
})
