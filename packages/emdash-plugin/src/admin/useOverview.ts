import type { OverviewResponse } from '../routes/admin'
import { useEffect, useState } from 'react'
import { loadOverview } from './api'
import { useAdminDict } from './i18n'

export type OverviewState
  = | { kind: 'loading' }
    | { kind: 'failed', message: string }
    | { kind: 'ready', overview: OverviewResponse }

/** Fetches `admin/overview` once on mount. Mount it under `AdminGate` so a non-administrator never requests it. */
export function useOverview(): OverviewState {
  const t = useAdminDict()
  const [state, setState] = useState<OverviewState>({ kind: 'loading' })
  useEffect(() => {
    let active = true
    loadOverview(t.loadFailed).then(
      (overview) => {
        if (active) {
          setState({ kind: 'ready', overview })
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ kind: 'failed', message: error instanceof Error ? error.message : t.loadFailed })
        }
      },
    )
    return () => {
      active = false
    }
    // The strings only matter for an error message; a locale switch must not refetch.
  }, [])
  return state
}
