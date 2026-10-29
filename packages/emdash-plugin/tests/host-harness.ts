import type { DayBucket } from '../src/buckets'
import type { NativePluginDeps } from '../src/native'
import type { PollSnapshot } from '../src/snapshot'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'bun:test'
import { createDialect } from 'emdash/db/sqlite'
import { dispatchPluginApiRequest, EmDashRuntime, handlePluginSettingsUpdate } from 'emdash/internal/plugin-test-runtime'
import { PLUGIN_ID } from '../src/descriptor'
import { createNativePlugin } from '../src/native'
import { POLL_SNAPSHOT_KEY } from '../src/snapshot'

/**
 * The harness for the native host tests. They run the native plugin on EmDash's real runtime
 * (`EmDashRuntime`, in-memory SQLite) and fire its `cron` hook the way the
 * scheduler does. The host's own SSRF guard stays in place: monitors use public
 * IP literals, which it accepts without a DNS lookup, and the underlying `fetch`
 * is the one seam, standing in for the internet. Nothing touches the network.
 */

// Public IP literals: the guard resolves hostnames over DoH, but not these.
export const HOST = '93.184.215.14'
export const SLACK = `https://${HOST}/slack/SLACKSECRET`
export const HOOK = `https://${HOST}/hook/HOOKSECRET`

export type Internet = (url: string, init?: RequestInit) => Response | Promise<Response>

/** The caller `dispatchPluginApiRequest` authenticates; omitted means anonymous. */
export interface TestUser {
  id: string
  email: string
  name: string | null
  role: number
  createdAt: string
}

export interface DispatchInit {
  method?: string
  query?: Record<string, string>
  body?: string
  headers?: Record<string, string>
  /** The authenticated user (a session cookie caller). */
  user?: TestUser
  /** Token scopes of a bearer-token caller. A token caller needs no `X-EmDash-Request` header. */
  tokenScopes?: string[]
}

const account = (role: number): TestUser => ({ id: `user-${role}`, email: `user${role}@example.com`, name: null, role, createdAt: '2026-01-01T00:00:00.000Z' })
/** Administrator (role 50): holds `plugins:manage`. */
export const ADMIN = account(50)
/** Editor (role 40): does not. */
export const EDITOR = account(40)
/** What the admin UI sends on every request. */
export const CSRF_HEADER = { 'X-EmDash-Request': '1' }

export interface Host {
  runtime: EmDashRuntime
  cron: (name: string) => Promise<boolean>
  setConfig: (yaml: string) => Promise<void>
  setSecrets: (secrets: Record<string, string>) => Promise<void>
  snapshot: () => Promise<PollSnapshot | null>
  buckets: () => Promise<DayBucket[]>
  /** The bucket rows by storage id (`slug:date`, or `slug:date:webhook`). */
  bucketRows: () => Promise<Record<string, DayBucket>>
  /** Write a plugin key-value entry (a snapshot, say) the way the plugin's `ctx.kv` stores it. */
  setKv: (key: string, value: unknown) => Promise<void>
  /** Every key-value entry the plugin has stored. */
  kvKeys: () => Promise<string[]>
  readKv: <T>(key: string) => Promise<T | null>
  /** Send a request through EmDash's production plugin-route boundary (`dispatchPluginApiRequest`). */
  dispatch: (route: string, init?: DispatchInit) => Promise<Response>
  tasks: () => Promise<Array<{ name: string, schedule: string, nextRunAt: string }>>
}

const runtimes: EmDashRuntime[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.shutdown()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

export async function newHost(internet: Internet, deps: NativePluginDeps = {}): Promise<Host> {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => internet(String(input instanceof Request ? input.url : input), init)) as typeof fetch
  const plugin = createNativePlugin({ fetchImpl, ...deps })
  // A file per host, and an entrypoint of its own: the runtime caches the database by entrypoint for the whole process.
  const dir = mkdtempSync(join(tmpdir(), 'statusbeam-host-'))
  dirs.push(dir)
  const runtime = await EmDashRuntime.create({
    config: { database: { entrypoint: `statusbeam-host-${dir}`, type: 'sqlite', config: { url: `file:${join(dir, 'db.sqlite')}` } } } as never,
    plugins: [plugin],
    createDialect: (config: { config?: unknown }) => createDialect((config.config ?? config) as never),
    createStorage: null,
    sandboxEnabled: false,
    sandboxedPluginEntries: [],
    createSandboxRunner: null,
  })
  runtimes.push(runtime)
  const option = (key: string) => `plugin:${PLUGIN_ID}:${key}`
  const read = async <T>(key: string): Promise<T | null> => {
    const row = await runtime.db.selectFrom('options').select('value').where('name', '=', option(key)).executeTakeFirst()
    return row ? JSON.parse(row.value) as T : null
  }
  return {
    runtime,
    cron: async (name) => {
      const result = await runtime.hooks.invokeCronHook(PLUGIN_ID, { name, scheduledAt: new Date().toISOString() })
      return result.success
    },
    setConfig: async (yaml) => {
      const value = JSON.stringify(yaml)
      await runtime.db.insertInto('options').values({ name: option('settings:config'), value }).onConflict(oc => oc.column('name').doUpdateSet({ value })).execute()
    },
    setSecrets: async (secrets) => {
      const result = await handlePluginSettingsUpdate(runtime.db, PLUGIN_ID, plugin.admin.settingsSchema ?? {}, secrets)
      expect(result.success).toBe(true)
    },
    snapshot: () => read<PollSnapshot>(POLL_SNAPSHOT_KEY),
    buckets: async () => {
      const rows = await runtime.db.selectFrom('_plugin_storage').select('data').where('plugin_id', '=', PLUGIN_ID).where('collection', '=', 'buckets').execute()
      return rows.map(row => JSON.parse(row.data) as DayBucket)
    },
    setKv: async (key, value) => {
      const json = JSON.stringify(value)
      await runtime.db.insertInto('options').values({ name: option(key), value: json }).onConflict(oc => oc.column('name').doUpdateSet({ value: json })).execute()
    },
    kvKeys: async () => {
      const rows = await runtime.db.selectFrom('options').select('name').where('name', 'like', `${option('')}%`).execute()
      return rows.map(row => row.name.slice(option('').length)).filter(key => !key.startsWith('settings:'))
    },
    readKv: read,
    dispatch: async (route, init = {}) => {
      const query = new URLSearchParams(init.query).toString()
      const request = new Request(`https://site.example.com/_emdash/api/plugins/${PLUGIN_ID}/${route}${query ? `?${query}` : ''}`, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      return dispatchPluginApiRequest({ runtime, pluginId: PLUGIN_ID, path: route, request, ...(init.user ? { user: init.user } : {}), ...(init.tokenScopes ? { tokenScopes: init.tokenScopes } : {}) })
    },
    bucketRows: async () => {
      const rows = await runtime.db.selectFrom('_plugin_storage').select(['id', 'data']).where('plugin_id', '=', PLUGIN_ID).where('collection', '=', 'buckets').execute()
      return Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.data) as DayBucket]))
    },
    tasks: async () => {
      const rows = await runtime.db.selectFrom('_emdash_cron_tasks').select(['task_name', 'schedule', 'next_run_at']).where('plugin_id', '=', PLUGIN_ID).execute()
      return rows.map(row => ({ name: row.task_name, schedule: row.schedule, nextRunAt: row.next_run_at }))
    },
  }
}

/** The host hands the request body on as bytes. */
export async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  return typeof body === 'string' ? body : new Response(body).text()
}

export const url = (name: string) => `https://${HOST}/${name}`
export const monitors = (names: string[]) => ['name: Test', 'sites:', ...names.flatMap(name => [`  - name: ${name}`, `    url: ${url(name)}`])].join('\n')
