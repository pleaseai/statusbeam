/**
 * Drive the ADR-0004 spike against one running spike site and print one JSON
 * line per run. Usage:
 *
 *   bun scripts/run-spike.ts <site-base-url> <mode-label> [fixtures|capacity|cpu|all]
 *
 * Each fixture and capacity case is its own route invocation, so one case
 * hitting a runtime limit cannot hide the others.
 */

import process from 'node:process'

const [base, mode = 'unknown', suite = 'all'] = process.argv.slice(2)
if (!base) {
  console.error('usage: bun scripts/run-spike.ts <site-base-url> <mode-label> [fixtures|capacity|cpu|all]')
  process.exit(2)
}

const ROUTES = `${base.replace(/\/$/, '')}/_emdash/api/plugins/statusbeam-spike-probe`

const FIXTURES = ['ok', 'status-503', 'nxdomain', 'big-7mib', 'big-9mib', 'slow-headers-3s', 'slow-body-3s', 'stream-20s', 'stream-120s']

/** [label, query] pairs for the FR-3 capacity matrix. */
const CAPACITY: Array<[string, Record<string, number | string>]> = [
  ['n8', { n: 8 }],
  ['n9', { n: 9 }],
  ['n10', { n: 10 }],
  ['n12', { n: 12 }],
  ['n20', { n: 20 }],
  ['n6+notify3', { n: 6, notify: 3 }],
  ['n8+kv2', { n: 8, kvWrites: 2 }],
  ['n8+log4', { n: 8, logs: 4 }],
]

/** parseConfig iterations per invocation, for the FR-20 CPU budget; the upper counts find where an invocation's CPU limit ends it. */
const CPU = [1, 5, 10, 25, 50, 100, 1000, 1500, 2000, 2500]

/** Client deadline per call: above the 120 s `stream-120s` fixture, so that case reports the host's outcome rather than the client's timeout. */
const CALL_TIMEOUT_MS = 150_000

async function call(route: string, query: Record<string, number | string>): Promise<unknown> {
  const url = `${ROUTES}/${route}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`
  const started = performance.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    }
    catch {}
    return { http: res.status, clientMs: Math.round(performance.now() - started), body }
  }
  catch (err) {
    return { http: 0, clientMs: Math.round(performance.now() - started), clientError: String(err) }
  }
}

function emit(kind: string, label: string, result: unknown): void {
  console.log(JSON.stringify({ mode, kind, label, at: new Date().toISOString(), result }))
}

if (suite === 'fixtures' || suite === 'all') {
  for (const fixture of FIXTURES) {
    emit('fixture', fixture, await call('probe', { fixture }))
  }
}
if (suite === 'capacity' || suite === 'all') {
  for (const [label, query] of CAPACITY) {
    emit('capacity', label, await call('capacity', { ...query, tag: `${mode}-${label}`.replace(/[^\w-]/g, '-') }))
  }
}
if (suite === 'cpu' || suite === 'all') {
  for (const parse of CPU) {
    emit('cpu', `parse${parse}`, await call('capacity', { n: 0, parse, tag: `${mode}-cpu${parse}` }))
  }
}
