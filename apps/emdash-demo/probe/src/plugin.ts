import type { CheckResult, Site } from '@statusbeam/core'
import type { PluginContext, SandboxedPlugin } from 'emdash/plugin'
import { buildStatusChangePayload, checkSite, parseConfig, siteSchema, toSlackMessage } from '@statusbeam/core'
import { REALISTIC_CONFIG } from './realistic-config'

/**
 * ADR-0004 probe-semantics spike plugin.
 *
 * Runs the real `checkSite` from `@statusbeam/core` with `fetchImpl` set to
 * `ctx.http.fetch`, against the spike fixture Worker. The same bundle runs in
 * all three EmDash execution modes; the site's `astro.config.mjs` picks the mode.
 * Spike-only: this is not the engine plugin.
 */

const FIXTURES = 'https://statusbeam-emdash-spike-fixtures.balancefriends.workers.dev'

/** Fixture name -> URL. Only these targets can be probed, so the public route cannot be aimed elsewhere. */
const FIXTURE_URLS: Record<string, string> = {
  'big-9mib': `${FIXTURES}/big?mib=9`,
  'big-7mib': `${FIXTURES}/big?mib=7`,
  'slow-body-3s': `${FIXTURES}/slow-body?ms=3000`,
  'slow-headers-3s': `${FIXTURES}/slow-headers?ms=3000`,
  'stream-20s': `${FIXTURES}/stream?s=20`,
  'stream-120s': `${FIXTURES}/stream?s=120`,
  'status-503': `${FIXTURES}/status/503`,
  'ok': `${FIXTURES}/ok`,
  'nxdomain': 'https://statusbeam-spike-nxdomain.invalid/',
}

interface RawError {
  name: string
  message: string
  ctor: string
  code?: unknown
  cause?: string
}

interface ProbeOutcome {
  label: string
  graded: CheckResult
  raw: RawError | null
  wallMs: number
}

function describeError(err: unknown): RawError {
  if (err instanceof Error) {
    const withCode = err as Error & { code?: unknown }
    return {
      name: err.name,
      message: err.message,
      ctor: err.constructor?.name ?? 'unknown',
      code: withCode.code,
      cause: err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : err.cause === undefined ? undefined : String(err.cause),
    }
  }
  return { name: typeof err, message: String(err), ctor: typeof err }
}

function siteFor(label: string, url: string): Site {
  return siteSchema.parse({ name: label, url, maxResponseTime: 2000 })
}

/** Reject after `ms`, so a probe can give up before the runner's wall-time limit kills the whole invocation. */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`spike probe timeout after ${ms}ms`)), ms))
}

/**
 * One `checkSite` call through `ctx.http.fetch`, keeping the raw rejection that
 * `checkHttp` flattens to a message. `timeoutMs > 0` races the fetch against a
 * plugin-side timer (the bridge takes no AbortSignal).
 */
async function probe(ctx: PluginContext, label: string, url: string, timeoutMs = 0): Promise<ProbeOutcome> {
  let raw: RawError | null = null
  const fetchImpl = async (target: string, init?: RequestInit): Promise<Response> => {
    try {
      const pending = ctx.http!.fetch(target, init)
      return await (timeoutMs > 0 ? Promise.race([pending, timeout(timeoutMs)]) : pending)
    }
    catch (err) {
      raw = describeError(err)
      throw err
    }
  }
  const started = Date.now()
  const graded = await checkSite(siteFor(label, url), { fetchImpl })
  return { label, graded, raw, wallMs: Date.now() - started }
}

interface CapacityInput {
  /** Monitors to probe, sequentially. */
  n: number
  /** Notification POSTs to send after the probes. */
  notify: number
  /** `ctx.kv.set` calls after the notifications. */
  kvWrites: number
  /** Items in one `ctx.storage.buckets.putMany` call after the KV writes (0 = no call). */
  putMany: number
  /** `ctx.log.info` calls before the probes. */
  logs: number
  /** `parseConfig(REALISTIC_CONFIG)` iterations before anything else (FR-20). */
  parse: number
  /** Tag appended to fixture paths so `wrangler tail` can attribute requests. */
  tag: string
}

interface StepOutcome {
  step: string
  ok: boolean
  detail?: string
  error?: RawError
}

function capacityInput(input: unknown): CapacityInput {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const num = (key: string, fallback: number): number => {
    const value = Number(source[key])
    return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 5000) : fallback
  }
  const tag = typeof source.tag === 'string' && /^[\w-]{1,40}$/.test(source.tag) ? source.tag : 'route'
  return { n: num('n', 12), notify: num('notify', 0), kvWrites: num('kvWrites', 0), putMany: num('putMany', 0), logs: num('logs', 0), parse: num('parse', 1), tag }
}

/**
 * The FR-3 capacity run: config re-validation, logging, N probes, notification
 * deliveries and KV writes, in that order. Every step is caught so the run
 * reports exactly which call first failed and whether later calls also failed.
 */
async function runCapacity(ctx: PluginContext, input: CapacityInput): Promise<{ input: CapacityInput, steps: StepOutcome[], probesUp: number }> {
  const steps: StepOutcome[] = []
  for (let i = 0; i < input.parse; i++) {
    try {
      const config = parseConfig(REALISTIC_CONFIG)
      steps.push({ step: `parse-${i}`, ok: true, detail: `${config.sites.length} sites` })
    }
    catch (err) {
      steps.push({ step: `parse-${i}`, ok: false, error: describeError(err) })
    }
  }
  for (let i = 0; i < input.logs; i++) {
    try {
      await ctx.log.info('spike log', { i })
      steps.push({ step: `log-${i}`, ok: true })
    }
    catch (err) {
      steps.push({ step: `log-${i}`, ok: false, error: describeError(err) })
    }
  }
  let probesUp = 0
  for (let i = 0; i < input.n; i++) {
    const outcome = await probe(ctx, `ok-${i}`, `${FIXTURES}/ok/${input.tag}/${i}`)
    if (outcome.graded.status === 'up') {
      probesUp++
    }
    steps.push({ step: `probe-${i}`, ok: outcome.graded.status === 'up', detail: `${outcome.graded.status} code=${outcome.graded.code}`, error: outcome.raw ?? undefined })
  }
  for (let i = 0; i < input.notify; i++) {
    const payload = buildStatusChangePayload([{ slug: `ok-${i}`, from: 'up', to: 'down' }], new Date().toISOString())
    try {
      const res = await ctx.http!.fetch(`${FIXTURES}/notify?tag=${input.tag}&i=${i}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toSlackMessage(payload)),
      })
      steps.push({ step: `notify-${i}`, ok: res.status === 204, detail: `status=${res.status}` })
    }
    catch (err) {
      steps.push({ step: `notify-${i}`, ok: false, error: describeError(err) })
    }
  }
  for (let i = 0; i < input.kvWrites; i++) {
    try {
      await ctx.kv.set(`spike:kv:${i}`, { at: new Date().toISOString() })
      steps.push({ step: `kv-${i}`, ok: true })
    }
    catch (err) {
      steps.push({ step: `kv-${i}`, ok: false, error: describeError(err) })
    }
  }
  if (input.putMany > 0) {
    const items = Array.from({ length: input.putMany }, (_, i) => ({ id: `${input.tag}-${i}`, data: { slug: `ok-${i}`, up: 1, total: 1 } }))
    try {
      await ctx.storage.buckets!.putMany(items)
      steps.push({ step: 'putMany', ok: true, detail: `${items.length} items` })
    }
    catch (err) {
      steps.push({ step: 'putMany', ok: false, error: describeError(err) })
    }
  }
  return { input, steps, probesUp }
}

function str(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>)[key] === 'string') {
    return (input as Record<string, string>)[key]
  }
  return undefined
}

const plugin: SandboxedPlugin = {
  hooks: {
    cron: async (event, ctx) => {
      const input = capacityInput({ ...event.data, tag: `cron-${event.name}` })
      const started = Date.now()
      // Engine deadline check: abandon a never-completing fetch at 10 s, then keep
      // making bridge calls (the probes and the closing KV write below).
      const hang = (event.data as Record<string, unknown> | undefined)?.hang === 1
        ? await probe(ctx, 'hang', FIXTURE_URLS['stream-120s']!, 10_000)
        : null
      const result = await runCapacity(ctx, input)
      const summary = {
        name: event.name,
        scheduledAt: event.scheduledAt,
        ranAt: new Date(started).toISOString(),
        wallMs: Date.now() - started,
        probesUp: result.probesUp,
        ...(hang ? { hang: { status: hang.graded.status, code: hang.graded.code, wallMs: hang.wallMs } } : {}),
        failed: result.steps.filter(s => !s.ok).map(s => `${s.step}: ${s.error?.message ?? s.detail}`),
      }
      // The summary write is itself a bridge call, so it can fail once a limit is hit.
      try {
        const history = (await ctx.kv.get<unknown[]>(`spike:cron:${event.name}`)) ?? []
        await ctx.kv.set(`spike:cron:${event.name}`, [...history.slice(-19), summary])
      }
      catch (err) {
        console.warn(JSON.stringify({ spikeCronSummaryLost: summary, error: describeError(err) }))
      }
    },
  },
  routes: {
    // Grade one fixture through checkSite + ctx.http.fetch.
    'probe': {
      public: true,
      handler: async (routeCtx, ctx) => {
        const fixture = str(routeCtx.input, 'fixture') ?? ''
        const url = FIXTURE_URLS[fixture]
        if (!url) {
          return { ok: false, error: 'UNKNOWN_FIXTURE', fixtures: Object.keys(FIXTURE_URLS) }
        }
        const timeoutMs = Number(str(routeCtx.input, 'timeoutMs') ?? '0')
        return { ok: true, outcome: await probe(ctx, fixture, url, Number.isFinite(timeoutMs) ? timeoutMs : 0) }
      },
    },
    // FR-3: config re-validation + N probes + notifications + KV writes in one invocation.
    'capacity': {
      public: true,
      handler: async (routeCtx, ctx) => ({ ok: true, ...(await runCapacity(ctx, capacityInput(routeCtx.input))) }),
    },
    // FR-4: register a cron task and report whether the schedule string was accepted.
    'cron-schedule': {
      public: true,
      handler: async (routeCtx, ctx) => {
        const name = str(routeCtx.input, 'name') ?? 'probe'
        const schedule = str(routeCtx.input, 'schedule') ?? '*/5 * * * *'
        const n = Number(str(routeCtx.input, 'n') ?? '12')
        try {
          const data = {
            n,
            notify: Number(str(routeCtx.input, 'notify') ?? '0'),
            parse: Number(str(routeCtx.input, 'parse') ?? '1'),
            hang: Number(str(routeCtx.input, 'hang') ?? '0'),
          }
          await ctx.cron!.schedule(name, { schedule, data })
          return { ok: true, name, schedule, tasks: await ctx.cron!.list() }
        }
        catch (err) {
          return { ok: false, name, schedule, error: describeError(err) }
        }
      },
    },
    'cron-cancel': {
      public: true,
      handler: async (routeCtx, ctx) => {
        const name = str(routeCtx.input, 'name') ?? 'probe'
        await ctx.cron!.cancel(name)
        return { ok: true, tasks: await ctx.cron!.list() }
      },
    },
    'cron-results': {
      public: true,
      handler: async (_routeCtx, ctx) => ({
        ok: true,
        tasks: await ctx.cron!.list(),
        runs: await ctx.kv.list('spike:cron:'),
      }),
    },
  },
}

export default plugin
