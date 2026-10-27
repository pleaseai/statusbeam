import { getDict } from '@statusbeam/core'
import { describe, expect, it } from 'bun:test'
import { buildConfig, buildMonitor, clientFindings, draftFromConfig, effectiveSlug, fieldKeyOf, findingsFromIssues, findingsWithoutRow, isRenamed, newRow } from '../src/admin/editor'

const t = getDict('en').admin

describe('the monitor editor model', () => {
  it('round-trips a stored document without adding defaults or dropping unknown keys', () => {
    const stored = {
      name: 'Acme',
      theme: { darkMode: false },
      sites: [
        { name: 'API', url: 'https://api.example.com', expectedStatusCodes: [200, 204], maxResponseTime: 800 },
        { name: 'Errors', check: 'sentry', url: 'https://sentry.io', sentry: { org: 'acme' } },
      ],
    }
    expect(buildConfig(draftFromConfig(stored))).toEqual(stored)
  })

  it('keeps a stored empty expectedStatusCodes until the field is edited', () => {
    const stored = { name: 'X', sites: [{ name: 'API', url: 'https://a.example', expectedStatusCodes: [] }] }
    const draft = draftFromConfig(stored)
    expect(buildConfig(draft)).toEqual(stored)
    draft.rows[0] = { ...draft.rows[0]!, emptyCodes: false }
    expect(buildMonitor(draft.rows[0]).monitor).not.toHaveProperty('expectedStatusCodes')
  })

  it('drops an emptied optional field so the schema default applies', () => {
    const row = draftFromConfig({ name: 'X', sites: [{ name: 'API', url: 'https://a.example', method: 'POST' }] }).rows[0]!
    const emptied = { ...row, monitor: { ...row.monitor, method: '  ', slug: '' }, codesText: '', maxText: '' }
    expect(buildMonitor(emptied).monitor).toEqual({ name: 'API', url: 'https://a.example' })
  })

  it('reports text that is not a whole number instead of saving a guess', () => {
    const draft = draftFromConfig({ name: 'X', sites: [{ name: 'API', url: 'https://a.example' }] })
    draft.rows[0] = { ...draft.rows[0]!, codesText: '200, abc', maxText: '5s' }
    expect(clientFindings(draft, t).fields).toEqual({ '0.expectedStatusCodes': t.monitors.wholeNumbers, '0.maxResponseTime': t.monitors.wholeNumber })
    expect(buildMonitor(draft.rows[0]!).monitor).not.toHaveProperty('expectedStatusCodes')
  })

  it('flags both monitors that share an effective slug, whether typed or derived from the name', () => {
    const draft = draftFromConfig({ name: 'X', sites: [{ name: 'API', url: 'https://a.example' }, { name: 'Other', slug: 'api', url: 'https://b.example' }, { name: 'Web', url: 'https://c.example' }] })
    expect(Object.keys(clientFindings(draft, t).fields).sort()).toEqual(['0.slug', '1.slug'])
    expect(clientFindings(draft, t).fields['1.slug']).toBe(t.monitors.duplicateSlug('api'))
  })

  it('treats a changed slug, or a changed name that derives it, as a rename; a new row never is', () => {
    const row = draftFromConfig({ name: 'X', sites: [{ name: 'API', url: 'https://a.example' }] }).rows[0]!
    expect(row.savedSlug).toBe('api')
    expect(isRenamed(row)).toBe(false)
    expect(isRenamed({ ...row, monitor: { ...row.monitor, slug: 'api-v2' } })).toBe(true)
    expect(isRenamed({ ...row, monitor: { ...row.monitor, name: 'API v2' } })).toBe(true)
    expect(isRenamed({ ...row, monitor: { ...row.monitor, name: 'API', slug: 'api' } })).toBe(false)
    expect(isRenamed(newRow())).toBe(false)
    expect(effectiveSlug({ name: 'Web Site' })).toBe('web-site')
  })

  it('maps issue paths onto fields and keeps warnings and unknown paths in the list', () => {
    expect(fieldKeyOf('sites[2].url')).toBe('2.url')
    expect(fieldKeyOf('sites[1].slug')).toBe('1.slug')
    expect(fieldKeyOf('name')).toBe('name')
    expect(fieldKeyOf('sites[0].sentry.org')).toBeNull()
    expect(fieldKeyOf('notifications.delivery')).toBeNull()
    const found = findingsFromIssues([
      { severity: 'error', path: 'sites[2].url', message: 'bad url' },
      { severity: 'error', path: 'sites[2].url', message: 'second' },
      { severity: 'error', path: 'sites[0].sentry.org', message: 'org missing' },
      { severity: 'warning', path: 'sites[1].slug', message: 'careful' },
    ])
    expect(found.fields).toEqual({ '2.url': 'bad url' })
    expect(found.other.map(issue => issue.message)).toEqual(['org missing', 'careful'])
  })
})

describe('findingsWithoutRow', () => {
  it('drops the removed row\'s other findings and re-indexes the later ones', () => {
    const other = [
      { severity: 'error' as const, path: 'sites[1].sentry.org', message: 'gone' },
      { severity: 'warning' as const, path: 'sites[2].url', message: 'warn' },
      { severity: 'error' as const, path: 'sites[3].sentry.org', message: 'org' },
      { severity: 'error' as const, path: 'sites[0].sentry.org', message: 'first' },
      { severity: 'error' as const, path: 'notifications.delivery', message: 'kept' },
    ]
    expect(findingsWithoutRow({ fields: {}, other }, 1).other).toEqual([
      { severity: 'warning', path: 'sites[1].url', message: 'warn' },
      { severity: 'error', path: 'sites[2].sentry.org', message: 'org' },
      { severity: 'error', path: 'sites[0].sentry.org', message: 'first' },
      { severity: 'error', path: 'notifications.delivery', message: 'kept' },
    ])
  })
})
