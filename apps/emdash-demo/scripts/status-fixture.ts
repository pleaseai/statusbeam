/**
 * Local fixture server for the status components and the "status" block demo.
 * It answers the StatusBeam public JSON from `@statusbeam/core`'s own builders,
 * so no network or deployment is involved. Usage:
 *
 *   bun scripts/status-fixture.ts [port]      # default 4420
 *
 * Serves both route flavors: `/api/status.json`, `/api/status/<slug>.json`
 * (standalone) and `/_emdash/api/plugins/statusbeam/status[?slug=<slug>]` (plugin).
 */

import type { SiteSummary } from '../../../packages/core/src/types'
import process from 'node:process'
import { buildSiteResponse, buildStatusResponse } from '../../../packages/core/src/contract'

const port = Number(process.argv[2] ?? 4420)

/** 90 days of history ending yesterday; `down` days sprinkled in. */
function history(downDays: number[]): SiteSummary['history'] {
  return Array.from({ length: 90 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 21) - (89 - i) * 86_400_000).toISOString().slice(0, 10)
    const down = downDays.includes(89 - i)
    return { date, status: down ? 'down' as const : 'up' as const, uptime: down ? 0.5 : 1 }
  })
}

const sites: SiteSummary[] = [
  { slug: 'api', name: 'API', status: 'up', responseTime: 120, uptimeDay: '100%', uptimeWeek: '99.98%', uptimeMonth: '99.9%', history: history([]) },
  { slug: 'web', name: 'Web app', status: 'degraded', responseTime: 480, uptimeDay: '98.2%', uptimeWeek: '99.1%', uptimeMonth: '99.4%', history: history([3, 40]) },
]

const json = (body: unknown, status = 200) => Response.json(body, { status })

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const url = new URL(request.url)
    const slug = url.pathname.match(/^\/api\/status\/([^/]+)\.json$/)?.[1] ?? url.searchParams.get('slug')
    const pluginRoute = url.pathname === '/_emdash/api/plugins/statusbeam/status'
    if (url.pathname === '/api/status.json' || (pluginRoute && !slug)) {
      return json(buildStatusResponse(sites))
    }
    const site = slug && sites.find(s => s.slug === slug)
    if (site && (url.pathname.startsWith('/api/status/') || pluginRoute)) {
      return json(buildSiteResponse(site))
    }
    return json({ error: 'not found' }, 404)
  },
})
console.log(`status fixture on http://127.0.0.1:${port}`)
