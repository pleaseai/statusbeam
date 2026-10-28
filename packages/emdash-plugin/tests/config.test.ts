import type { SecretsView } from '../src/config'
import { describe, expect, it } from 'bun:test'
import { clearConfigError, CONFIG_ERROR_KEY, MAX_MONITORS, readConfigError, secretsFrom, validatePluginConfig } from '../src/config'
import { runMaintenance } from '../src/run'
import { reconcileSchedule } from '../src/schedule'
import { createFakeContext, monitorNames, monitorsYaml, runFake } from './fake-context'

const NONE: SecretsView = { destinations: 0, sentryToken: false, invalidEntries: [], extraSlackUrls: 0 }
const VALID = monitorsYaml(['alpha', 'beta'])

function yamlWith(sites: string[]): string {
  return ['name: Test', 'sites:', ...sites].join('\n')
}

function issuesOf(yaml: string, secrets = NONE, severity?: 'error' | 'warning') {
  return validatePluginConfig(yaml, secrets).issues.filter(issue => !severity || issue.severity === severity)
}

describe('validatePluginConfig', () => {
  it('accepts a plain document and runs the core schema first, keeping its issue paths (FR-14)', () => {
    expect(validatePluginConfig(VALID, NONE)).toMatchObject({ ok: true, issues: [] })
    expect(validatePluginConfig(VALID, NONE).config?.sites).toHaveLength(2)

    const bad = validatePluginConfig(yamlWith(['  - name: a', '    url: not-a-url']), NONE)
    expect(bad.ok).toBe(false)
    expect(bad.config).toBeUndefined()
    expect(bad.issues).toEqual([expect.objectContaining({ severity: 'error', path: 'sites[0].url' })])

    const syntax = validatePluginConfig('sites: [broken', NONE)
    expect(syntax).toMatchObject({ ok: false, issues: [{ severity: 'error', path: '' }] })
  })

  it('accepts MAX_MONITORS monitors and rejects one more as an error on sites', () => {
    expect(MAX_MONITORS).toBe(400)
    expect(validatePluginConfig(monitorsYaml(monitorNames(MAX_MONITORS)), NONE)).toMatchObject({ ok: true, issues: [] })

    const over = validatePluginConfig(monitorsYaml(monitorNames(MAX_MONITORS + 1)), NONE)
    expect(over.ok).toBe(false)
    expect(over.config).toBeUndefined()
    expect(over.issues).toEqual([expect.objectContaining({ severity: 'error', path: 'sites', message: expect.stringContaining('401 monitors') })])
    expect(over.issues[0]!.message).toContain('at most 400')
  })

  it('rejects delivery: queue as an error on notifications.delivery (AC-018)', () => {
    const result = validatePluginConfig(`${VALID}\nnotifications:\n  delivery: queue`, NONE)
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', path: 'notifications.delivery' })])
    expect(validatePluginConfig(`${VALID}\nnotifications:\n  delivery: inline`, NONE).ok).toBe(true)
  })

  it('saves TCP and SSL monitors with a warning that names the monitor (AC-019)', () => {
    const yaml = yamlWith(['  - name: web', '    url: https://web.example.com/', '  - name: db', '    check: tcp', '    url: tcp://db.example.com:5432', '  - name: cert', '    check: ssl', '    url: https://cert.example.com/'])
    const result = validatePluginConfig(yaml, NONE)
    expect(result.ok).toBe(true)
    expect(result.issues.map(i => [i.severity, i.path])).toEqual([['warning', 'sites[1].check'], ['warning', 'sites[2].check']])
    expect(result.issues[0]?.message).toContain('over HTTP')
  })

  it('warns when a Sentry poll monitor has no token, and not when one is set or the monitor is webhook-only (AC-020)', () => {
    const poll = yamlWith(['  - name: errors', '    check: sentry', '    url: https://sentry.example.com/', '    sentry:', '      org: acme'])
    expect(validatePluginConfig(poll, NONE)).toMatchObject({ ok: true, issues: [{ severity: 'warning', path: 'sites[0].sentry' }] })
    expect(issuesOf(poll, { ...NONE, sentryToken: true })).toEqual([])
    const hookOnly = yamlWith(['  - name: errors', '    check: sentry', '    url: https://sentry.example.com/'])
    expect(issuesOf(hookOnly)).toEqual([])
  })

  it('rejects a Slack or webhook URL in the YAML and points to the encrypted settings (AC-022)', () => {
    const yaml = `${VALID}\nnotifications:\n  slack:\n    webhookUrl: https://hooks.slack.com/services/SECRET\n  webhooks:\n    - url: https://hooks.example.com/SECRET2\n    - url: https://hooks.example.com/SECRET3`
    const result = validatePluginConfig(yaml, NONE)
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.path)).toEqual(['notifications.slack', 'notifications.webhooks[0]', 'notifications.webhooks[1]'])
    expect(result.issues[0]?.message).toContain('slackWebhookUrl')
    expect(result.issues[1]?.message).toContain('webhookUrls')
    expect(JSON.stringify(result.issues)).not.toContain('SECRET')
  })

  it('rejects duplicate slugs, explicit or derived, at the later monitor', () => {
    const yaml = yamlWith(['  - name: Web App', '    url: https://a.example.com/', '  - name: other', '    slug: web-app', '    url: https://b.example.com/'])
    const result = validatePluginConfig(yaml, NONE)
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', path: 'sites[1].slug' })])
    expect(result.issues[0]?.message).toContain('sites[0]')
  })

  it('reports secret URL lines that are not URLs by line, never quoting them', () => {
    const { secrets } = secretsFrom(new Map<string, unknown>([
      ['webhookUrls', 'https://ok.example.com/a\nnot-a-url-TOKEN123\n\nftp://x.example.com/ https://ok.example.com/b'],
      ['slackWebhookUrl', 'nope'],
    ]))
    expect(secrets.invalidEntries).toEqual([{ field: 'slackWebhookUrl', line: 1 }, { field: 'webhookUrls', line: 2 }, { field: 'webhookUrls', line: 4 }])
    const result = validatePluginConfig(VALID, secrets)
    expect(result.ok).toBe(true)
    expect(result.issues.map(i => [i.severity, i.path])).toEqual([['warning', 'slackWebhookUrl'], ['warning', 'webhookUrls'], ['warning', 'webhookUrls']])
    expect(result.issues[1]?.message).toContain('Line 2')
    expect(JSON.stringify(result.issues)).not.toContain('TOKEN123')
  })

  it('warns, without quoting them, about Slack URLs past the first, which receive nothing', () => {
    const { secrets } = secretsFrom(new Map<string, unknown>([['slackWebhookUrl', 'https://hooks.slack.com/a/SECRET1\nhttps://hooks.slack.com/b/SECRET2 https://hooks.slack.com/c/SECRET3']]))
    expect(secrets.extraSlackUrls).toBe(2)
    expect(secrets.invalidEntries).toEqual([])
    const result = validatePluginConfig(VALID, secrets)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'warning', path: 'slackWebhookUrl', message: expect.stringContaining('holds 3 URLs, but only the first') })])
    expect(JSON.stringify(result.issues)).not.toContain('SECRET')
  })
})

describe('the run gate', () => {
  const INVALID = `${VALID}\nnotifications:\n  delivery: queue`
  const at = (time: string) => ({ now: () => new Date(time) })

  /** A valid run first, so there are buckets, a snapshot and tasks to protect. */
  async function seeded() {
    const fake = createFakeContext({ config: VALID, tasks: [{ name: 'check', schedule: '*/5 * * * *' }] })
    await runFake(fake, at('2026-10-22T10:00:00.000Z'))
    return fake
  }

  const state = (fake: ReturnType<typeof createFakeContext>) => JSON.stringify([[...fake.rows], [...fake.kv].filter(([key]) => key !== CONFIG_ERROR_KEY), [...fake.tasks]])

  it('checks nothing and changes no status, making only the settings read and one record write (AC-023)', async () => {
    const fake = await seeded()
    const before = state(fake)
    fake.setConfig(INVALID)
    fake.bridgeCalls.length = 0

    const result = await runFake(fake, at('2026-10-22T10:05:00.000Z'))

    expect(result).toEqual({ probed: 0, deliveries: 0 })
    expect(fake.bridgeCalls).toEqual(['settings.list', 'kv.set'])
    expect(state(fake)).toBe(before)
  })

  it('records the errors, keeps them across further invalid runs, and leaves the tasks alone (AC-024)', async () => {
    const fake = await seeded()
    fake.setConfig(INVALID)
    await runFake(fake, at('2026-10-22T10:05:00.000Z'))
    expect(await readConfigError(fake.ctx)).toMatchObject({ version: 1, issues: [{ severity: 'error', path: 'notifications.delivery' }] })

    await runFake(fake, at('2026-10-22T10:10:00.000Z'))
    await reconcileSchedule(fake.ctx)
    await runMaintenance(fake.ctx, at('2026-10-22T10:15:00.000Z'))
    expect(await readConfigError(fake.ctx)).not.toBeNull()
    expect([...fake.tasks.keys()].sort()).toEqual(['check', 'maintenance'])
  })

  it('clears the record in the first run that validates', async () => {
    const fake = await seeded()
    fake.setConfig(INVALID)
    await runFake(fake)
    expect(fake.kv.has(CONFIG_ERROR_KEY)).toBe(true)

    fake.setConfig(VALID)
    fake.bridgeCalls.length = 0
    const result = await runFake(fake)
    expect(fake.kv.has(CONFIG_ERROR_KEY)).toBe(false)
    expect(result.probed).toBe(2)
    expect(fake.bridgeCalls.filter(c => c === 'kv.delete')).toHaveLength(1)
  })

  it('records nothing for an absent configuration, and clearing a record is one call', async () => {
    const fake = createFakeContext()
    await runFake(fake)
    expect(fake.bridgeCalls).toEqual(['settings.list'])
    fake.kv.set(CONFIG_ERROR_KEY, { version: 1 })
    fake.bridgeCalls.length = 0
    await clearConfigError(fake.ctx)
    expect(fake.bridgeCalls).toEqual(['kv.delete'])
    expect(await readConfigError(fake.ctx)).toBeNull()
  })
})
