import type { HttpAccess, PluginContext, RouteContext } from 'emdash'
import { checkSite, siteSchema } from '@statusbeam/core'
import { definePlugin } from 'emdash'
import pkg from '../package.json' with { type: 'json' }
import { PLUGIN_ID } from './descriptor'
import { createProbeHttp } from './http'

/**
 * The native plugin (T001 spike, ADR-0005 track). The descriptor's
 * `entrypoint`: EmDash imports `createPlugin` from here and calls it with the
 * descriptor's `options`. It runs in `plugins: []`, with no sandbox runner.
 *
 * Spike scope only: one scheduled task that records its runs, a public probe
 * route over fixed targets, and a placeholder admin page and widget. T002
 * replaces the task and the probe route with the engine.
 */

/** The spike's scheduled task. Every minute is the floor on both hosts. */
export const SPIKE_TASK = 'spike-tick'
const SPIKE_SCHEDULE = '* * * * *'
const RUNS_KEY = 'spike:cron-runs'
const MAX_RUNS = 20

/**
 * Fixed probe targets, so the public route cannot be aimed anywhere else. The
 * ADR-0004 fixture Worker is gone, so the public targets are third-party
 * endpoints: httpbin's `drip` sends headers at once and the body over 3 s, and
 * Cloudflare's speed-test download serves a 9 MiB body.
 */
export const SPIKE_TARGETS: Record<string, string> = {
  'slow-body-3s': 'https://httpbin.org/drip?duration=3&numbytes=10&delay=0&code=200',
  'big-9mib': 'https://speed.cloudflare.com/__down?bytes=9437184',
  'ok': 'https://httpbin.org/status/200',
  'loopback': 'http://127.0.0.1/',
  // A public name whose A record is 127.0.0.1, not on the host's wildcard-DNS
  // denylist: only the guard's DNS lookup can refuse it.
  'dns-loopback': 'http://localhost.direct/',
  'metadata': 'http://169.254.169.254/latest/meta-data/',
  'redirect-to-metadata': 'https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F',
}

interface CronRun {
  name: string
  scheduledAt: string
  ranAt: string
}

async function recordRun(ctx: PluginContext, run: CronRun): Promise<void> {
  const runs = (await ctx.kv.get<CronRun[]>(RUNS_KEY)) ?? []
  await ctx.kv.set(RUNS_KEY, [run, ...runs].slice(0, MAX_RUNS))
}

/**
 * Schedule the task unless it already is. `schedule()` is an upsert that moves
 * the next run to the next match, so calling it on every request would keep
 * postponing a task that a once-a-minute trigger never finds due.
 */
async function scheduleSpikeTask(ctx: PluginContext): Promise<void> {
  if (!ctx.cron) {
    return
  }
  const tasks = await ctx.cron.list()
  if (!tasks.some(task => task.name === SPIKE_TASK && task.schedule === SPIKE_SCHEDULE)) {
    await ctx.cron.schedule(SPIKE_TASK, { schedule: SPIKE_SCHEDULE })
  }
}

interface ProbeReport {
  mode: 'header' | 'body'
  status: string
  code: number
  responseTime: number
  error?: string
  /** Time from the final hop's dispatch to its headers, header mode only. */
  headersMs?: number
  wallMs: number
}

/**
 * One `checkSite` over `http`. In header mode the raw fetch under the host's
 * guard is wrapped once more to time the final hop's headers, which excludes the
 * guard's DNS lookups from the figure.
 */
async function probeOnce(mode: ProbeReport['mode'], http: HttpAccess, url: string, timing: { headersMs?: number }): Promise<ProbeReport> {
  const site = siteSchema.parse({ name: 'spike', url, maxResponseTime: 2000 })
  const started = Date.now()
  const result = await checkSite(site, { fetchImpl: (target, init) => http.fetch(target, init) })
  return {
    mode,
    status: result.status,
    code: result.code,
    responseTime: result.responseTime,
    ...(result.error ? { error: result.error } : {}),
    ...(timing.headersMs === undefined ? {} : { headersMs: timing.headersMs }),
    wallMs: Date.now() - started,
  }
}

async function probeRoute(ctx: RouteContext): Promise<unknown> {
  const params = new URL(ctx.request.url).searchParams
  const name = params.get('target') ?? ''
  const url = SPIKE_TARGETS[name]
  if (!url) {
    return { error: `unknown target "${name}"`, targets: Object.keys(SPIKE_TARGETS) }
  }
  const timing: { headersMs?: number } = {}
  const timedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const sent = Date.now()
    const response = await globalThis.fetch(input, init)
    timing.headersMs = Date.now() - sent
    return response
  }) as typeof fetch
  const reports = [await probeOnce('header', createProbeHttp(PLUGIN_ID, timedFetch), url, timing)]
  if (params.get('body') === '1' && ctx.http) {
    reports.push(await probeOnce('body', ctx.http, url, {}))
  }
  // The user agent tells the hosts apart: `Cloudflare-Workers` under workerd, `Node.js/...` on Node.
  return { target: name, url, runtime: globalThis.navigator?.userAgent ?? null, reports }
}

export function createPlugin(_options: Record<string, unknown> = {}) {
  return definePlugin({
    id: PLUGIN_ID,
    version: pkg.version,
    capabilities: ['network:request:unrestricted'],
    hooks: {
      'plugin:activate': async (_event, ctx) => {
        await scheduleSpikeTask(ctx)
      },
      'cron': async (event, ctx) => {
        if (event.name !== SPIKE_TASK) {
          return
        }
        const run = { name: event.name, scheduledAt: event.scheduledAt, ranAt: new Date().toISOString() }
        ctx.log.info('statusbeam spike cron fired', run)
        await recordRun(ctx, run)
      },
    },
    routes: {
      'spike-probe': { public: true, handler: probeRoute },
      'spike-cron': {
        public: true,
        handler: async (ctx) => {
          // Covers a site where activate never ran; a no-op once scheduled.
          await scheduleSpikeTask(ctx)
          return { tasks: (await ctx.cron?.list()) ?? null, runs: (await ctx.kv.get<CronRun[]>(RUNS_KEY)) ?? [] }
        },
      },
    },
    admin: {
      entry: '@statusbeam/emdash-plugin/admin',
      pages: [{ path: '/', label: 'StatusBeam', icon: 'chart-line' }],
      widgets: [{ id: 'status', title: 'StatusBeam', size: 'half' }],
    },
  })
}
