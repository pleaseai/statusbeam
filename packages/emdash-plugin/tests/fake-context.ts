import type { PluginContext } from 'emdash/plugin'
import type { DayBucket } from '../src/buckets'

export type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface FakeContextOptions {
  /** The YAML under the `config` settings key. */
  config?: string
  fetch?: FakeFetch
  buckets?: DayBucket[]
  tasks?: Array<{ name: string, schedule: string }>
}

type Where = Record<string, string | { gte?: string, lt?: string }>

function matches(row: DayBucket, where: Where | undefined): boolean {
  return Object.entries(where ?? {}).every(([field, condition]) => {
    const value = row[field as keyof DayBucket] as string
    if (typeof condition === 'string') {
      return value === condition
    }
    return (condition.gte === undefined || value >= condition.gte) && (condition.lt === undefined || value < condition.lt)
  })
}

/**
 * An in-memory `PluginContext` that counts every bridge call the way Worker
 * Loader does: each method call on `http`, `kv`, `storage`, `settings`, `cron`
 * and `log` is one call. `bridgeCalls` holds them in order, as `namespace.method`.
 */
export function createFakeContext(options: FakeContextOptions = {}) {
  const bridgeCalls: string[] = []
  const track = <T>(label: string, fn: () => T): T => {
    bridgeCalls.push(label)
    return fn()
  }

  const settings = new Map<string, unknown>()
  if (options.config !== undefined) {
    settings.set('config', options.config)
  }
  const kv = new Map<string, unknown>()
  const rows = new Map<string, DayBucket>((options.buckets ?? []).map(b => [`${b.slug}:${b.date}`, b]))
  const tasks = new Map<string, { name: string, schedule: string, data?: Record<string, unknown> }>(
    (options.tasks ?? []).map(t => [t.name, t]),
  )

  const buckets = {
    getMany: async (ids: string[]) => track('storage.getMany', () => new Map(ids.flatMap(id => (rows.has(id) ? [[id, rows.get(id) as DayBucket] as const] : [])))),
    putMany: async (items: Array<{ id: string, data: DayBucket }>) => track('storage.putMany', () => {
      for (const item of items) {
        rows.set(item.id, item.data)
      }
    }),
    deleteMany: async (ids: string[]) => track('storage.deleteMany', () => ids.filter(id => rows.delete(id)).length),
    query: async (query: { where?: Where, limit?: number }) => track('storage.query', () => {
      const all = [...rows].filter(([, data]) => matches(data, query.where)).map(([id, data]) => ({ id, data }))
      const items = all.slice(0, query.limit ?? 50)
      return { items, hasMore: all.length > items.length }
    }),
  }

  const ctx = {
    settings: {
      get: async (key: string) => track('settings.get', () => (settings.has(key) ? settings.get(key) : null)),
      set: async (key: string, value: unknown) => track('settings.set', () => void settings.set(key, value)),
    },
    kv: {
      get: async (key: string) => track('kv.get', () => (kv.has(key) ? kv.get(key) : null)),
      set: async (key: string, value: unknown) => track('kv.set', () => void kv.set(key, value)),
      list: async (prefix = '') => track('kv.list', () => [...kv].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))),
    },
    storage: { buckets },
    http: {
      fetch: async (url: string, init?: RequestInit) => track('http.fetch', () => (options.fetch ?? (async () => new Response('ok', { status: 200 })))(url, init)),
    },
    cron: {
      schedule: async (name: string, opts: { schedule: string, data?: Record<string, unknown> }) => track('cron.schedule', () => void tasks.set(name, { name, ...opts })),
      cancel: async (name: string) => track('cron.cancel', () => void tasks.delete(name)),
      list: async () => track('cron.list', () => [...tasks.values()].map(t => ({ name: t.name, schedule: t.schedule, nextRunAt: '', lastRunAt: null }))),
    },
    log: {
      debug: (message: string) => track('log.debug', () => void message),
      info: (message: string) => track('log.info', () => void message),
      warn: (message: string) => track('log.warn', () => void message),
      error: (message: string) => track('log.error', () => void message),
    },
  }

  return {
    ctx: ctx as unknown as PluginContext,
    bridgeCalls,
    rows,
    kv,
    tasks,
    setConfig: (yaml: string) => void settings.set('config', yaml),
  }
}

export function monitorsYaml(names: string[], extra: string[] = []): string {
  return [
    'name: Test',
    'sites:',
    ...names.flatMap(name => [`  - name: ${name}`, `    url: https://${name}.example.com/`]),
    ...extra,
  ].join('\n')
}

export function monitorNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `m${String(i).padStart(3, '0')}`)
}
