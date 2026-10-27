import type { ReactNode } from 'react'
import type { Monitor } from './editor'
import { TestMonitor } from './TestMonitor'

export interface MonitorActionsProps {
  /** The monitor as it would be saved right now, unsaved edits included. Fields whose text is not a number are left out. */
  monitor: Monitor
  /** The slug the monitor has in the saved configuration, or `null` for a monitor added in this session. */
  savedSlug: string | null
  /** True while the editor saves; actions that write should wait. */
  busy: boolean
}

/** The actions at the foot of every monitor in the editor. */
export function MonitorActions({ monitor, busy }: MonitorActionsProps): ReactNode {
  return <TestMonitor monitor={monitor} busy={busy} />
}
