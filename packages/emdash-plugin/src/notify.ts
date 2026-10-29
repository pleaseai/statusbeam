import type { NotificationMessage, StatusChange } from '@statusbeam/core'
import type { Destination } from './settings'
import { buildNotificationMessages, buildStatusChangePayload } from '@statusbeam/core'
import { fetchWithDeadline } from './probe'

type DeliveryFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * What a delivery left behind. It is the plugin's delivery log: stored in the
 * poll snapshot, not in `ctx.log`. It holds
 * no secret: the target is the destination's host with a trailing ellipsis
 * (`hooks.slack.com/…`), because the path and query of a webhook URL are the
 * secret, and the error is a class, not the host's message, which can quote the URL.
 */
export interface DeliveryOutcome {
  kind: Destination['kind']
  /** Host plus an ellipsis, e.g. `hooks.slack.com/…`. */
  target: string
  ok: boolean
  /** HTTP status of the response, when one arrived. */
  status?: number
  /** `deadline` for a delivery that did not finish in time, `error` for any other failure. */
  error?: 'deadline' | 'error'
}

/** Destination host with an ellipsis in place of the secret path. */
export function redactDestination(url: string): string {
  return URL.canParse(url) ? `${new URL(url).host}/…` : '<invalid url>…'
}

/**
 * One ready-to-POST message per destination, all carrying the same set of
 * changes. It reuses core's fan-out so the Slack and generic bodies match the
 * standalone ones; the URLs come only from the secret settings.
 */
export function buildMessages(destinations: Destination[], changes: StatusChange[], timestamp: string): NotificationMessage[] {
  const slack = destinations.find(d => d.kind === 'slack')
  const webhooks = destinations.filter(d => d.kind === 'webhook')
  return buildNotificationMessages(
    {
      delivery: 'inline',
      ...(slack ? { slack: { webhookUrl: slack.url } } : {}),
      ...(webhooks.length ? { webhooks: webhooks.map(d => ({ url: d.url })) } : {}),
    },
    buildStatusChangePayload(changes, timestamp),
  )
}

/**
 * POST each message through `ctx.http.fetch`, concurrently, under the same
 * deadline as a probe. Failures are recorded, never thrown, so one bad
 * destination cannot stop the run's writes. Core's `deliverNotification` is not
 * used: this records an outcome per destination with a redacted target.
 */
export async function deliver(
  fetchImpl: DeliveryFetch,
  destinations: Destination[],
  messages: NotificationMessage[],
  deadlineMs: number,
): Promise<DeliveryOutcome[]> {
  const post = fetchWithDeadline(fetchImpl, deadlineMs)
  return Promise.all(messages.map(async (message, index): Promise<DeliveryOutcome> => {
    // `buildMessages` emits the Slack message first, then the webhooks, in destination order.
    const destination = destinations[index] as Destination
    const base = { kind: destination.kind, target: redactDestination(message.url) }
    try {
      const res = await post(message.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.body),
      })
      return { ...base, ok: res.ok, status: res.status }
    }
    catch (error) {
      return { ...base, ok: false, error: isDeadline(error) ? 'deadline' : 'error' }
    }
  }))
}

/** Whether `error` is the deadline: our own rejection, or the abort its signal raised first. */
function isDeadline(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('deadline'))
}
