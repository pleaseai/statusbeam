import { describe, expect, it, spyOn } from 'bun:test'
import { buildStatusChangePayload } from './notify'
import { buildNotificationMessages, deliverNotification, dispatchNotifications, redactUrl } from './notify-delivery'

const payload = buildStatusChangePayload([{ slug: 'api', from: 'up', to: 'down' }], '2026-07-08T00:00:00.000Z')

function fakeFetch(ok: boolean) {
  const urls: string[] = []
  const impl = (async (url: string) => {
    urls.push(url)
    return { ok, status: ok ? 200 : 500 } as Response
  }) as unknown as typeof fetch
  return { impl, urls }
}

describe('notification delivery', () => {
  const notifications = {
    delivery: 'inline' as const,
    slack: { webhookUrl: 'https://hooks.slack.com/services/SECRET' },
    webhooks: [{ url: 'https://example.com/hook?token=SECRET' }],
  }

  it('builds one message per target, none without notifications', () => {
    expect(buildNotificationMessages(undefined, payload)).toEqual([])
    const messages = buildNotificationMessages(notifications, payload)
    expect(messages.map(m => m.url)).toEqual([notifications.slack.webhookUrl, notifications.webhooks[0]!.url])
    expect(messages[1]!.body).toEqual(payload)
  })

  it('redacts a url to its origin', () => {
    expect(redactUrl('https://hooks.slack.com/services/SECRET?x=1')).toBe('https://hooks.slack.com')
    expect(redactUrl('not a url')).toBe('<invalid url>')
  })

  it('dispatches to every target through the injected fetch', async () => {
    const { impl, urls } = fakeFetch(true)
    await dispatchNotifications(notifications, payload, impl)
    expect([...urls].sort()).toEqual([notifications.slack.webhookUrl, notifications.webhooks[0]!.url].sort())
  })

  it('throws on non-2xx without leaking the url path or token', async () => {
    const { impl } = fakeFetch(false)
    const err = await deliverNotification({ url: 'https://example.com/hook?token=SECRET', body: {} }, impl).then(() => undefined, (e: Error) => e)
    expect(err?.message).toContain('https://example.com')
    expect(err?.message).not.toContain('SECRET')
    expect(err?.message).not.toContain('example.com/hook')
  })

  it('logs a failed inline delivery as a fixed category and the origin, never the error text', async () => {
    const logged: unknown[][] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args))
    try {
      // A runtime's fetch error can quote the full URL, path and token included.
      const throwing = (async (url: string) => {
        throw new TypeError(`fetch failed: ${url}`)
      }) as unknown as typeof fetch
      await dispatchNotifications(notifications, payload, throwing)
      await dispatchNotifications(notifications, payload, fakeFetch(false).impl)
    }
    finally {
      spy.mockRestore()
    }
    const lines = logged.map(args => args.map(String).join(' '))
    expect(lines).toHaveLength(4)
    expect(lines).toContain('notify: POST https://example.com failed (network)')
    expect(lines).toContain('notify: POST https://hooks.slack.com failed (http)')
    for (const line of lines) {
      expect(line).not.toContain('SECRET')
      expect(line).not.toContain('example.com/hook')
      expect(line).not.toContain('slack.com/services')
      expect(line).not.toContain('token')
      expect(line).not.toContain('?')
    }
  })

  it('never throws from inline dispatch when a target fails', async () => {
    const { impl } = fakeFetch(false)
    await expect(dispatchNotifications(notifications, payload, impl)).resolves.toBeUndefined()
  })
})
