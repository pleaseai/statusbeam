import type { ReactNode } from 'react'
import type { Monitor } from './editor'
import { TestMonitor } from './TestMonitor'

export interface MonitorActionsProps {
  /** The monitor as it would be saved right now, unsaved edits included. Fields whose text is not a number are left out. */
  monitor: Monitor
  /** Identity of the row's raw inputs; a change, even one that leaves `monitor` the same, invalidates a shown test result. */
  inputKey: string
  /** True while the editor saves; actions that write should wait. */
  busy: boolean
}

/** The actions at the foot of every monitor in the editor. */
export function MonitorActions({ monitor, inputKey, busy }: MonitorActionsProps): ReactNode {
  return <TestMonitor monitor={monitor} inputKey={inputKey} busy={busy} />
}
