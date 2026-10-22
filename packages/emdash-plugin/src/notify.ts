import type { NotificationMessage, StatusChange } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import type { Destination } from './settings'
import { buildNotificationMessages, buildStatusChangePayload } from '@statusbeam/core'
import { withDeadline } from './probe'

type HostFetch = NonNullable<PluginContext['http']>['fetch']

/**
 * What a delivery left behind. It is the plugin's delivery log: stored in the
 * shard snapshot, never in `ctx.log` (a log call costs a bridge call). It holds
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
 * POST each message through `ctx.http.fetch`, concurrently, one call each, under
 * the same deadline as a probe. Failures are recorded, never thrown, so one bad
 * destination cannot stop the run's writes. Core's `deliverNotification` is not
 * used: it passes an `AbortSignal`, which the bridge does not take.
 */
export async function deliver(
  fetchImpl: HostFetch,
  destinations: Destination[],
  messages: NotificationMessage[],
  deadlineMs: number,
): Promise<DeliveryOutcome[]> {
  return Promise.all(messages.map(async (message, index): Promise<DeliveryOutcome> => {
    // `buildMessages` emits the Slack message first, then the webhooks, in destination order.
    const destination = destinations[index] as Destination
    const base = { kind: destination.kind, target: redactDestination(message.url) }
    try {
      const res = await withDeadline(fetchImpl(message.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.body),
      }), deadlineMs)
      return { ...base, ok: res.ok, status: res.status }
    }
    catch (error) {
      return { ...base, ok: false, error: error instanceof Error && error.message.includes('deadline') ? 'deadline' : 'error' }
    }
  }))
}
