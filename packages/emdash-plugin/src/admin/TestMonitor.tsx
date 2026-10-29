import type { Dict } from '@statusbeam/core'
import type { TestResponse } from '../routes/admin'
import type { Monitor } from './editor'
import { Button } from '@cloudflare/kumo'
import { getDict } from '@statusbeam/core'
import { useEffect, useRef, useState } from 'react'
import { SENTRY_TOKEN_SECRET_KEY } from '../settings'
import { postAdmin } from './api'
import { useAdminLocale } from './i18n'

export interface TestMonitorProps {
  /** The monitor as it would be saved right now; this exact copy is tested, so an unsaved edit is checked before a save. */
  monitor: Monitor
  /** Identity of the raw inputs behind `monitor`; any change discards the shown result and ignores an in-flight response. */
  inputKey: string
  /** True while the editor saves; a test waits for it. */
  busy: boolean
}

type Outcome = { kind: 'response', response: TestResponse } | { kind: 'failed' }

/**
 * "Test this monitor": runs one check through the `admin/test` route and shows
 * its status, response time and response code. The route records nothing, so a
 * test leaves history, the snapshot and notifications as they were.
 */
export function TestMonitor({ monitor, inputKey, busy }: TestMonitorProps) {
  const locale = useAdminLocale()
  const dict = getDict(locale)
  const t = dict.admin.monitors.test
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const monitorKey = `${JSON.stringify(monitor)}\n${inputKey}`
  const requestId = useRef(0)
  useEffect(() => {
    requestId.current += 1
    setOutcome(null)
    setRunning(false)
  }, [monitorKey])

  async function run() {
    const id = ++requestId.current
    setRunning(true)
    setOutcome(null)
    let next: Outcome
    try {
      next = { kind: 'response', response: await postAdmin<TestResponse>('test', { monitor }, t.failed) }
    }
    catch {
      next = { kind: 'failed' }
    }
    if (mounted.current && id === requestId.current) {
      setOutcome(next)
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" disabled={running || busy} onClick={run}>
        {running ? t.running : t.action}
      </Button>
      <div aria-live="polite" className="text-sm">
        {outcome !== null && <Result outcome={outcome} dict={dict} />}
      </div>
    </div>
  )
}

function Result({ outcome, dict }: { outcome: Outcome, dict: Dict }) {
  const t = dict.admin.monitors.test
  if (outcome.kind === 'failed') {
    return <p className="text-kumo-danger">{t.failed}</p>
  }
  const { response } = outcome
  if (!response.tested) {
    const issues = response.reason === 'invalid' ? response.issues : []
    return (
      <div className="text-kumo-danger">
        <p>{reasonText(dict.admin.monitors.testReason, response)}</p>
        {issues.length > 0 && (
          <ul className="space-y-1">
            {issues.map(issue => <li key={`${issue.path}:${issue.message}`}>{issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`}</li>)}
          </ul>
        )}
      </div>
    )
  }
  const { result } = response
  if (result.limit === 'body') {
    return <p>{t.unsupported}</p>
  }
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Figure label={t.status} value={dict.day[result.status]} strong />
      <Figure label={t.responseTime} value={`${result.responseTime} ${dict.unit.ms}`} />
      <Figure label={t.responseCode} value={result.code === 0 ? t.noResponse : String(result.code)} />
      {result.error !== undefined && <Figure label={t.error} value={result.error} />}
    </dl>
  )
}

/**
 * The text for a refusal, in the admin's language. The route's English `message` stays on
 * the wire for other clients, and is shown for a reason this bundle does not know yet.
 */
function reasonText(t: Dict['admin']['monitors']['testReason'], refusal: Exclude<TestResponse, { tested: true }>): string {
  switch (refusal.reason) {
    case 'invalid': return t.invalid
    case 'not-found': return t.notFound
    case 'webhook-only': return t.webhookOnly
    case 'no-token': return t.noToken(SENTRY_TOKEN_SECRET_KEY)
    case 'no-network': return t.noNetwork
    default: return (refusal as { message: string }).message
  }
}

function Figure({ label, value, strong }: { label: string, value: string, strong?: boolean }) {
  return (
    <div className="flex gap-1">
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className={strong ? 'font-medium' : undefined}>{value}</dd>
    </div>
  )
}
