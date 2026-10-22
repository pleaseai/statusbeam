import type { NotificationMessage, Notifications, StatusChangePayload } from '@statusbeam/core'
import type { Env } from './env'
import { buildNotificationMessages, deliverNotification, dispatchNotifications, postAllNotifications } from '@statusbeam/core'

// Message building and inline delivery live in core; re-exported so the Worker's
// public surface (and its tests) keep importing them from here.
export { buildNotificationMessages, deliverNotification, dispatchNotifications }
export type { NotificationMessage }

/** Cloudflare Queues caps a single `sendBatch` at 100 messages. */
const QUEUE_BATCH_LIMIT = 100

/**
 * Deliver a status-change payload, picking the transport from
 * `notifications.delivery` (see {@link Notifications}):
 *
 * - `queue`: enqueue one message per target onto {@link Env.NOTIFY_QUEUE} so a
 *   consumer dispatches them with the queue's retries + dead-lettering.
 * - `inline` (default): POST each target directly here.
 *
 * Falls back to inline dispatch — so a status change is never silently dropped —
 * whenever the queue path can't be taken:
 * - the queue binding is absent (misconfiguration, or the free plan where Queues
 *   is unavailable), or
 * - the enqueue itself fails (`sendBatch` throws on a quota/throttle/transient
 *   API error).
 * Both cases warn the operator so the misconfiguration or outage is visible.
 */
export async function notify(
  env: Env,
  notifications: Notifications | undefined,
  payload: StatusChangePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (notifications?.delivery === 'queue') {
    if (env.NOTIFY_QUEUE) {
      const messages = buildNotificationMessages(notifications, payload)
      if (messages.length === 0) {
        return
      }
      // Chunk to the sendBatch limit so a large target list still takes the
      // queue path instead of erroring straight into the inline fallback.
      let enqueued = 0
      try {
        for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
          const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT)
          await env.NOTIFY_QUEUE.sendBatch(chunk.map(body => ({ body })))
          enqueued += chunk.length
        }
        return
      }
      catch (err) {
        // A chunk failed to enqueue. `sendBatch` is atomic per call, so
        // `enqueued` counts only fully-accepted chunks — fall back to inline for
        // just the un-enqueued remainder. Re-dispatching the already-queued
        // messages would double-deliver them. Log with the file's `notify:`
        // style (counts, never payload contents).
        console.error(`notify: enqueue failed after ${enqueued}/${messages.length} message(s); dispatching the rest inline`, err)
        await postAllNotifications(fetchImpl, messages.slice(enqueued))
        return
      }
    }
    else {
      console.warn(
        'notify: notifications.delivery is "queue" but the NOTIFY_QUEUE binding is missing; '
        + 'add the queues.producers binding in wrangler.jsonc. Falling back to inline dispatch.',
      )
    }
  }
  await dispatchNotifications(notifications, payload, fetchImpl)
}

/**
 * Queue consumer: deliver each message, acking on success and retrying on
 * failure. Cloudflare Queues re-delivers retried messages with backoff and,
 * once `max_retries` is exhausted, routes them to the configured dead-letter
 * queue — so a persistently failing target surfaces there, never silently
 * dropped. Messages are settled independently so one bad target doesn't force
 * healthy ones to redeliver.
 */
export async function consumeNotificationBatch(
  batch: MessageBatch<NotificationMessage>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await deliverNotification(message.body, fetchImpl)
      }
      catch (err) {
        // Delivery failed — retry so Queues re-delivers and eventually
        // dead-letters. Keep `ack()` out of this try so a post-success ack
        // failure isn't misread as a delivery failure and spuriously retried.
        console.error(`notify: queue delivery failed, retrying`, err)
        // Do NOT swallow a retry() failure: an unsettled message is implicitly
        // acked when the handler returns, so swallowing here would silently drop
        // a notification that failed to deliver. Let it propagate — the batch
        // fails and Queues redelivers the message. (A settle call throwing is a
        // near-impossible runtime edge; when it does, redelivering — duplicates
        // and all — beats dropping an alert.)
        message.retry()
        return
      }
      try {
        message.ack()
      }
      catch (err) {
        // Delivery already succeeded; a failed ack must not crash the batch or
        // trigger a retry (that would re-POST a delivered notification). Log in
        // the file's `notify:` style and let Queues auto-settle the message.
        console.error(`notify: ack failed after successful delivery`, err)
      }
    }),
  )
}
