import type { DayStat, ResponsePoint } from './types'
import { describe, expect, it } from 'bun:test'
import { averageResponse, formatUptime, overallSeverity, percentileResponse, toSeverity, uptimeFigure, windowUptime } from './types'

function day(status: DayStat['status'], uptime: number): DayStat {
  return { date: '2026-01-01', status, uptime }
}

function points(...ms: number[]): ResponsePoint[] {
  return ms.map(m => ({ at: '2026-01-01T00:00:00.000Z', ms: m }))
}

describe('toSeverity', () => {
  it('maps check statuses to display severities', () => {
    expect(toSeverity('up')).toBe('operational')
    expect(toSeverity('degraded')).toBe('degraded')
    expect(toSeverity('down')).toBe('major_outage')
  })
})

describe('overallSeverity', () => {
  it('is operational when everything is up', () => {
    expect(overallSeverity(['up', 'up'])).toBe('operational')
  })

  it('picks the worst status (down beats degraded)', () => {
    expect(overallSeverity(['up', 'degraded', 'down'])).toBe('major_outage')
    expect(overallSeverity(['up', 'degraded'])).toBe('degraded')
  })

  it('is operational for an empty list', () => {
    expect(overallSeverity([])).toBe('operational')
  })
})

describe('windowUptime', () => {
  it('averages the uptime of days that have data', () => {
    expect(windowUptime([day('up', 1), day('degraded', 0.98)])).toBeCloseTo(0.99)
  })

  it('ignores no-data days', () => {
    // Only the two data days count; the null day is excluded.
    expect(windowUptime([day('up', 1), day(null, 1), day('down', 0)])).toBeCloseTo(0.5)
  })

  it('returns 1 when the window is empty or entirely no-data', () => {
    expect(windowUptime([])).toBe(1)
    expect(windowUptime([day(null, 1), day(null, 1)])).toBe(1)
  })
})

describe('uptimeFigure', () => {
  it('formats the window uptime of a checked site with data', () => {
    expect(uptimeFigure({ history: [day('up', 1), day(null, 1), day('down', 0)] })).toBe('50.00%')
  })

  it('has no figure for a pending site or a window with no checked day, instead of 100%', () => {
    expect(uptimeFigure({ pending: true, history: [day('up', 1)] })).toBeNull()
    expect(uptimeFigure({ history: [day(null, 1), day(null, 1)] })).toBeNull()
    expect(uptimeFigure({ history: [] })).toBeNull()
  })
})

describe('formatUptime', () => {
  it('formats a ratio as a two-decimal percentage', () => {
    expect(formatUptime(0.9998)).toBe('99.98%')
    expect(formatUptime(0.9)).toBe('90.00%')
  })

  it('collapses a rounded 100 to "100%"', () => {
    expect(formatUptime(1)).toBe('100%')
    expect(formatUptime(0.99999)).toBe('100%')
  })
})

describe('averageResponse', () => {
  it('rounds the mean of the samples', () => {
    expect(averageResponse(points(100, 200, 301))).toBe(200)
    expect(averageResponse(points(10, 15))).toBe(13)
  })

  it('returns 0 for an empty window', () => {
    expect(averageResponse([])).toBe(0)
  })
})

describe('percentileResponse', () => {
  it('picks the nearest-rank value for a percentile', () => {
    const window = points(50, 40, 30, 20, 10)
    expect(percentileResponse(window, 0.95)).toBe(50)
    expect(percentileResponse(window, 0.5)).toBe(30)
  })

  it('clamps p to the first/last sample at the extremes', () => {
    const window = points(30, 10, 20)
    expect(percentileResponse(window, 0)).toBe(10)
    expect(percentileResponse(window, 1)).toBe(30)
  })

  it('returns 0 for an empty window', () => {
    expect(percentileResponse([], 0.95)).toBe(0)
  })
})
