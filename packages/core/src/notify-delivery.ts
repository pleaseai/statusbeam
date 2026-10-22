import type { Notifications } from './config'
import type { StatusChangePayload } from './notify'
import { toSlackMessage } from './notify'

/**
 * A single ready-to-POST notification: one target URL and its JSON body. Slack
 * carries its Block Kit message; generic webhooks carry the channel-agnostic
 * payload. This is the wire shape for both delivery modes — inline dispatch
 * POSTs it directly; queue dispatch enqueues it as one message.
 */
export interface NotificationMessage {
  url: string
  body: unknown
}

/**
 * Fan a status-change payload out into one {@link NotificationMessage} per
 * configured target. Shared by every delivery mode so they dispatch to exactly
 * the same set of targets with the same bodies.
 */
export function buildNotificationMessages(
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
): NotificationMessage[] {
  if (!notifications) {
    return []
  }
  const messages: NotificationMessage[] = []
  if (notifications.slack) {
    messages.push({ url: notifications.slack.webhookUrl, body: toSlackMessage(payload) })
  }
  for (const hook of notifications.webhooks ?? []) {
    messages.push({ url: hook.url, body: payload })
  }
  return messages
}

/** Scheme + host only — webhook URLs embed secrets (Slack path, `?token=`). */
export function redactUrl(url: string): string {
  try {
    return new URL(url).origin
  }
  catch {
    return '<invalid url>'
  }
}

/** A delivery that completed with a non-2xx response; its message names only the redacted target and the status. */
class NotificationHttpError extends Error {}

/**
 * POST one notification message. Throws on a network error or a non-2xx
 * response so a queue consumer retries (and eventually dead-letters) it. The
 * inline path wraps this to swallow failures instead.
 */
export async function deliverNotification(
  message: NotificationMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(message.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.body),
    // Cap a slow/hung target so it can't stall the queue consumer (or hold an
    // inline `ctx.waitUntil`). A timeout aborts as a throw → the consumer
    // retries (transient), the inline path swallows it.
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new NotificationHttpError(`POST ${redactUrl(message.url)} failed (${res.status})`)
  }
}

/** What kind of failure a delivery hit, without any of the error's own text. */
function failureCategory(err: unknown): 'http' | 'timeout' | 'network' {
  if (err instanceof NotificationHttpError) {
    return 'http'
  }
  const name = err instanceof Error ? err.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
}

/** Inline variant of {@link deliverNotification}: logs failures, never throws. */
async function postJson(fetchImpl: typeof fetch, message: NotificationMessage): Promise<void> {
  try {
    await deliverNotification(message, fetchImpl)
  }
  catch (err) {
    // A fixed category and the redacted origin only: a runtime's fetch error
    // message can quote the full URL, whose path or query is the secret.
    console.error(`notify: POST ${redactUrl(message.url)} failed (${failureCategory(err)})`)
  }
}

/** POST every message inline, swallowing individual failures. */
export async function postAllNotifications(fetchImpl: typeof fetch, messages: NotificationMessage[]): Promise<void> {
  await Promise.allSettled(messages.map(m => postJson(fetchImpl, m)))
}

/**
 * Inline dispatch: POST every target directly. Failures are logged, never
 * thrown, so one bad target cannot wedge the run and a status change still
 * reaches the healthy targets. Best-effort — no retries. Resolves once every
 * dispatch settles.
 */
export async function dispatchNotifications(
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postAllNotifications(fetchImpl, buildNotificationMessages(notifications, payload))
}
