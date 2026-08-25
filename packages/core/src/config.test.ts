import { describe, expect, it } from 'bun:test'
import { configSchema, notificationsSchema, parseConfig } from './config'

const baseYaml = `
name: Example Status
sites:
  - name: Example
    url: https://example.com
`

describe('parseConfig', () => {
  it('parses a minimal config and slugifies site names', () => {
    const config = parseConfig(baseYaml)
    expect(config.name).toBe('Example Status')
    expect(config.sites[0]?.slug).toBe('example')
  })

  it('leaves notifications undefined when the block is absent', () => {
    expect(parseConfig(baseYaml).notifications).toBeUndefined()
  })

  it('accepts a valid explicit slug', () => {
    const config = parseConfig(`${baseYaml}    slug: my-api\n`)
    expect(config.sites[0]?.slug).toBe('my-api')
  })

  it('rejects an explicit slug with Cache-Tag-unsafe characters', () => {
    // A comma would split the Cache-Tag header into bogus tags.
    expect(() => parseConfig(`${baseYaml}    slug: my,service\n`)).toThrow()
  })

  it('accepts the statuspage check kind with a component', () => {
    const config = parseConfig(`${baseYaml}    check: statuspage\n    component: Claude API\n`)
    expect(config.sites[0]?.check).toBe('statuspage')
    expect(config.sites[0]?.component).toBe('Claude API')
  })

  it('accepts the incidentio check kind with a component', () => {
    const config = parseConfig(`${baseYaml}    check: incidentio\n    component: API\n`)
    expect(config.sites[0]?.check).toBe('incidentio')
    expect(config.sites[0]?.component).toBe('API')
  })

  it('rejects an unknown check kind', () => {
    expect(() => parseConfig(`${baseYaml}    check: carrier-pigeon\n`)).toThrow()
  })

  it('rejects an empty component string', () => {
    expect(() => parseConfig(`${baseYaml}    check: statuspage\n    component: ""\n`)).toThrow()
  })

  it('rejects component on a non-statuspage check kind', () => {
    // A mistyped `check` should surface as a parse error, not silently ignore
    // the component.
    expect(() => parseConfig(`${baseYaml}    check: http\n    component: Some Service\n`)).toThrow()
  })

  it('accepts a webhook-only sentry check (no sentry block)', () => {
    const config = parseConfig(`${baseYaml}    check: sentry\n`)
    expect(config.sites[0]?.check).toBe('sentry')
    expect(config.sites[0]?.sentry).toBeUndefined()
  })

  it('accepts a sentry check with a poll-backstop block', () => {
    const config = parseConfig(
      `${baseYaml}    check: sentry\n    sentry:\n      org: acme\n      project: api\n      host: https://us.sentry.io\n`,
    )
    expect(config.sites[0]?.check).toBe('sentry')
    expect(config.sites[0]?.sentry?.org).toBe('acme')
    expect(config.sites[0]?.sentry?.project).toBe('api')
    expect(config.sites[0]?.sentry?.host).toBe('https://us.sentry.io')
  })

  it('rejects a sentry block missing the required org', () => {
    expect(() => parseConfig(`${baseYaml}    check: sentry\n    sentry:\n      project: api\n`)).toThrow()
  })

  it('rejects a sentry block on a non-sentry check kind', () => {
    expect(() => parseConfig(`${baseYaml}    check: http\n    sentry:\n      org: acme\n`)).toThrow()
  })

  it('rejects an invalid sentry host URL', () => {
    expect(() => parseConfig(`${baseYaml}    check: sentry\n    sentry:\n      org: acme\n      host: not-a-url\n`)).toThrow()
  })
})

const aigatewayYaml = `
name: Example Status
sites:
  - name: Claude Opus 4.5
    check: aigateway
    aigateway:
`

describe('parseConfig with an aigateway site', () => {
  it('parses a minimal aigateway site and applies the uptime defaults', () => {
    const config = parseConfig(`${aigatewayYaml}      provider: vercel\n      model: anthropic/claude-opus-4.5\n`)
    const site = config.sites[0]
    expect(site?.check).toBe('aigateway')
    expect(site?.aigateway?.provider).toBe('vercel')
    expect(site?.aigateway?.model).toBe('anthropic/claude-opus-4.5')
    expect(site?.aigateway?.degradedUptime).toBe(99)
    expect(site?.aigateway?.downUptime).toBe(50)
    expect(site?.aigateway?.endpoint).toBeUndefined()
  })

  it('fills url with the gateway endpoints URL when the site omits it', () => {
    const config = parseConfig(`${aigatewayYaml}      provider: openrouter\n      model: anthropic/claude-opus-4.5\n`)
    expect(config.sites[0]?.url).toBe('https://openrouter.ai/api/v1/models/anthropic/claude-opus-4.5/endpoints')
  })

  it('keeps an explicit url when one is given', () => {
    const config = parseConfig(
      `${aigatewayYaml}      provider: vercel\n      model: anthropic/claude-opus-4.5\n    url: https://example.com\n`,
    )
    expect(config.sites[0]?.url).toBe('https://example.com')
  })

  it('accepts an endpoint and custom uptime thresholds', () => {
    const config = parseConfig(
      `${aigatewayYaml}      provider: openrouter\n      model: anthropic/claude-opus-4.5\n      endpoint: amazon-bedrock\n      degradedUptime: 95\n      downUptime: 80\n`,
    )
    expect(config.sites[0]?.aigateway?.endpoint).toBe('amazon-bedrock')
    expect(config.sites[0]?.aigateway?.degradedUptime).toBe(95)
    expect(config.sites[0]?.aigateway?.downUptime).toBe(80)
  })

  it('rejects an unknown provider', () => {
    expect(() => parseConfig(`${aigatewayYaml}      provider: bedrock\n      model: anthropic/claude-opus-4.5\n`)).toThrow()
  })

  it('rejects a model that is not in creator/model form', () => {
    expect(() => parseConfig(`${aigatewayYaml}      provider: vercel\n      model: claude-opus-4.5\n`)).toThrow()
    expect(() => parseConfig(`${aigatewayYaml}      provider: vercel\n      model: a/b/c\n`)).toThrow()
  })

  it('rejects downUptime above degradedUptime', () => {
    expect(() =>
      parseConfig(`${aigatewayYaml}      provider: vercel\n      model: anthropic/claude-opus-4.5\n      degradedUptime: 90\n      downUptime: 95\n`),
    ).toThrow()
  })

  it('rejects check: aigateway without an aigateway block', () => {
    expect(() => parseConfig(`${baseYaml}    check: aigateway\n`)).toThrow()
  })

  it('rejects an aigateway block on a non-aigateway check kind', () => {
    expect(() =>
      parseConfig(`${baseYaml}    check: http\n    aigateway:\n      provider: vercel\n      model: anthropic/claude-opus-4.5\n`),
    ).toThrow()
  })

  it('rejects a site with no url on a non-aigateway check kind', () => {
    // `url` is optional in the schema only so an aigateway site can omit it;
    // every other kind still has to supply one.
    expect(() => parseConfig('name: Example Status\nsites:\n  - name: Example\n    check: http\n')).toThrow()
  })
})

describe('theme.locale', () => {
  it('defaults to en when theme is absent', () => {
    expect(parseConfig(baseYaml).theme.locale).toBe('en')
  })

  it('defaults to en when theme is present without a locale', () => {
    const config = parseConfig(`${baseYaml}\ntheme:\n  darkMode: false\n`)
    expect(config.theme.locale).toBe('en')
  })

  it('accepts a supported locale', () => {
    const config = parseConfig(`${baseYaml}\ntheme:\n  locale: ko\n`)
    expect(config.theme.locale).toBe('ko')
  })

  it('rejects an unsupported locale', () => {
    expect(() => parseConfig(`${baseYaml}\ntheme:\n  locale: fr\n`)).toThrow()
  })
})

describe('notificationsSchema', () => {
  it('accepts a valid slack webhook and generic webhooks', () => {
    const parsed = notificationsSchema.parse({
      slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      webhooks: [{ url: 'https://example.com/hook' }],
    })
    expect(parsed.slack?.webhookUrl).toBe('https://hooks.slack.com/services/T/B/X')
    expect(parsed.webhooks).toHaveLength(1)
  })

  it('accepts an empty object (all targets optional) and defaults delivery to inline', () => {
    expect(notificationsSchema.parse({})).toEqual({ delivery: 'inline' })
  })

  it('accepts an explicit queue delivery mode', () => {
    expect(notificationsSchema.parse({ delivery: 'queue' }).delivery).toBe('queue')
  })

  it('rejects an unknown delivery mode', () => {
    expect(() => notificationsSchema.parse({ delivery: 'carrier-pigeon' })).toThrow()
  })

  it('rejects an invalid slack webhook URL', () => {
    expect(() => notificationsSchema.parse({ slack: { webhookUrl: 'not-a-url' } })).toThrow()
  })

  it('rejects an invalid generic webhook URL', () => {
    expect(() => notificationsSchema.parse({ webhooks: [{ url: 'nope' }] })).toThrow()
  })
})

describe('configSchema with notifications', () => {
  it('parses a config that includes a notifications block', () => {
    const config = configSchema.parse({
      name: 'Example Status',
      sites: [{ name: 'Example', url: 'https://example.com' }],
      notifications: { slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' } },
    })
    expect(config.notifications?.slack?.webhookUrl).toBe(
      'https://hooks.slack.com/services/T/B/X',
    )
  })

  it('rejects a config with an invalid webhook URL', () => {
    expect(() =>
      configSchema.parse({
        name: 'Example Status',
        sites: [{ name: 'Example', url: 'https://example.com' }],
        notifications: { webhooks: [{ url: 'bad' }] },
      }),
    ).toThrow()
  })
})
