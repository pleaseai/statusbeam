import type { ReactNode } from 'react'
import type { Monitor } from './editor'

export interface MonitorActionsProps {
  /** The monitor as it would be saved right now, unsaved edits included. Fields whose text is not a number are left out. */
  monitor: Monitor
  /** The slug the monitor has in the saved configuration, or `null` for a monitor added in this session. */
  savedSlug: string | null
  /** True while the editor saves; actions that write should wait. */
  busy: boolean
}

/**
 * The slot at the foot of every monitor in the editor. It renders nothing yet:
 * the "Test this monitor" action (T006) goes here, and gets the monitor with
 * its unsaved edits so a test can run before a save.
 */
export function MonitorActions(_props: MonitorActionsProps): ReactNode {
  return null
}
