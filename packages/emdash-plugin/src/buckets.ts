import type { CheckResult, DayCounts } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import { historyWindowStart } from '@statusbeam/core'

/** The storage collection declared under `storage` in `native.ts`. */
export const BUCKETS_COLLECTION = 'buckets'

/** Rows one `query()` returns at most. */
const QUERY_PAGE_LIMIT = 100

/**
 * One (monitor, UTC day) row of per-status check counts. The same counts the
 * standalone worker derives from `GROUP BY slug, date(checked_at)`, so core's
 * rollup turns either source into identical per-day stats.
 */
export interface DayBucket {
  slug: string
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string
  up: number
  degraded: number
  down: number
  total: number
}

/** The slice of a storage collection this plugin uses. */
interface BucketCollection {
  getMany: (ids: string[]) => Promise<Map<string, DayBucket>>
  putMany: (items: Array<{ id: string, data: DayBucket }>) => Promise<void>
  deleteMany: (ids: string[]) => Promise<number>
  query: (options: {
    where?: Record<string, string | { gte?: string, lt?: string }>
    limit?: number
  }) => Promise<{ items: Array<{ id: string, data: DayBucket }>, hasMore: boolean }>
}

export function bucketsOf(ctx: Pick<PluginContext, 'storage'>): BucketCollection {
  const collection = ctx.storage[BUCKETS_COLLECTION]
  if (!collection) {
    throw new Error(`storage collection "${BUCKETS_COLLECTION}" is not declared`)
  }
  return collection as unknown as BucketCollection
}

/**
 * Who increments a bucket row. The scheduled check owns the `poll` rows and the
 * webhook route owns the `webhook` rows, so neither ever read-modify-writes a
 * row the other writes.
 */
export type BucketSource = 'poll' | 'webhook'

/**
 * Storage id of a bucket. Slugs are `[a-z0-9-]`, so `:` cannot collide: a poll
 * id has one colon, a webhook id two.
 */
export function bucketId(slug: string, date: string, source: BucketSource = 'poll'): string {
  return source === 'webhook' ? `${slug}:${date}:webhook` : `${slug}:${date}`
}

/** UTC day of a check, taken from its ISO `checkedAt` the way D1's `date(checked_at)` does. */
export function dayOf(result: Pick<CheckResult, 'checkedAt'>): string {
  return result.checkedAt.slice(0, 10)
}

/** Storage ids of the buckets `results` will touch, deduplicated. */
export function touchedBucketIds(results: CheckResult[]): string[] {
  return [...new Set(results.map(r => bucketId(r.slug, dayOf(r))))]
}

/**
 * Add `results` to the buckets they fall in. `existing` maps bucket id to the
 * stored row; a missing row starts at zero. Returns only the rows that changed,
 * ready for one `putMany`. Pure: it never mutates `existing`. `source` picks
 * which rows (`poll` by default) the counts go into.
 */
export function applyResults(
  existing: Map<string, DayBucket>,
  results: CheckResult[],
  source: BucketSource = 'poll',
): Array<{ id: string, data: DayBucket }> {
  const next = new Map<string, DayBucket>()
  for (const r of results) {
    const date = dayOf(r)
    const id = bucketId(r.slug, date, source)
    const bucket = next.get(id) ?? { ...(existing.get(id) ?? { slug: r.slug, date, up: 0, degraded: 0, down: 0, total: 0 }) }
    bucket[r.status] += 1
    bucket.total += 1
    next.set(id, bucket)
  }
  return [...next].map(([id, data]) => ({ id, data }))
}

/** A bucket as the row shape core's rollup takes. */
export function toDayCounts(bucket: DayBucket): DayCounts {
  return { slug: bucket.slug, day: bucket.date, up: bucket.up, degraded: bucket.degraded, down: bucket.down, total: bucket.total }
}

/** First UTC day still inside the 90-day window ending on `now`'s day; older buckets are expired. */
export function windowStartDate(now: Date): string {
  return historyWindowStart(now).toISOString().slice(0, 10)
}

/**
 * Read one monitor's buckets inside the 90-day window: 90 days fit one 100-row page.
 * A day with webhook events has two rows (poll and webhook); a reader sums them.
 */
export async function readMonitorBuckets(
  ctx: Pick<PluginContext, 'storage'>,
  slug: string,
  now: Date,
): Promise<DayBucket[]> {
  const page = await bucketsOf(ctx).query({
    where: { slug, date: { gte: windowStartDate(now) } },
    limit: QUERY_PAGE_LIMIT,
  })
  return page.items.map(item => item.data)
}

/**
 * Delete buckets that fell out of the 90-day window, a page of up to 100 expired
 * rows at a time until none are left. Returns how many it deleted.
 */
export async function pruneExpiredBuckets(ctx: Pick<PluginContext, 'storage'>, now: Date): Promise<number> {
  const buckets = bucketsOf(ctx)
  const cutoff = windowStartDate(now)
  let deleted = 0
  for (;;) {
    const page = await buckets.query({ where: { date: { lt: cutoff } }, limit: QUERY_PAGE_LIMIT })
    if (page.items.length === 0) {
      return deleted
    }
    const removed = await buckets.deleteMany(page.items.map(item => item.id))
    deleted += removed
    // A page that deleted nothing would be read again forever.
    if (removed === 0) {
      return deleted
    }
  }
}
