import { describe, expect, it } from 'bun:test'
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
    expect(urls).toHaveLength(2)
  })

  it('throws on non-2xx without leaking the url path or token', async () => {
    const { impl } = fakeFetch(false)
    const err = await deliverNotification({ url: 'https://example.com/hook?token=SECRET', body: {} }, impl).then(() => undefined, (e: Error) => e)
    expect(err?.message).toContain('https://example.com')
    expect(err?.message).not.toContain('SECRET')
  })

  it('never throws from inline dispatch when a target fails', async () => {
    const { impl } = fakeFetch(false)
    await expect(dispatchNotifications(notifications, payload, impl)).resolves.toBeUndefined()
  })
})
