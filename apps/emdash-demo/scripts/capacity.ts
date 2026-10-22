/**
 * Ad-hoc capacity runs: one `capacity` route call per query string, summarized
 * as passed steps and the first failures. Usage:
 *
 *   bun scripts/capacity.ts <site-base-url> "n=12" "n=0&kvWrites=12" "n=0&parse=1000"
 */

import process from 'node:process'

interface Step {
  step: string
  ok: boolean
  detail?: string
  error?: { name: string, message: string, ctor: string }
}

const [base, ...queries] = process.argv.slice(2)
if (!base || queries.length === 0) {
  console.error('usage: bun scripts/capacity.ts <site-base-url> <query> [query...]')
  process.exit(2)
}

const ROUTE = `${base.replace(/\/$/, '')}/_emdash/api/plugins/statusbeam-spike-probe/capacity`

for (const query of queries) {
  const started = performance.now()
  const res = await fetch(`${ROUTE}?${query}&tag=adhoc`)
  const ms = Math.round(performance.now() - started)
  const text = await res.text()
  let body: { success?: boolean, data?: { steps: Step[] } } | undefined
  try {
    body = JSON.parse(text)
  }
  catch {}
  if (!body?.success || !body.data) {
    console.log(query, res.status, `${ms}ms`, text.slice(0, 300))
    continue
  }
  const steps = body.data.steps
  const failed = steps.filter(s => !s.ok)
  const firstFailures = failed
    .slice(0, 2)
    .map(s => `${s.step}: ${(s.error?.message ?? s.detail ?? '').slice(0, 70)}${s.error ? ` [${s.error.name}]` : ''}`)
  console.log(query, res.status, `${ms}ms`, `ok ${steps.length - failed.length}/${steps.length}`, firstFailures.join(' | '))
}
