/**
 * The descriptor's `adminEntry`. EmDash imports this module into the admin
 * bundle and looks pages up by path and widgets by id. Components take no
 * props, and the host does not role-gate them: each refuses a non-administrator
 * itself (see `AdminGate`). The admin's CSS is precompiled, so only classes the
 * admin itself uses take effect, and layout uses logical properties for RTL.
 * T007 replaces the widget.
 */
import { MonitorsPage } from './MonitorsPage'

function SpikeWidget() {
  return (
    <p className="p-4 text-sm text-kumo-subtle" data-testid="statusbeam-spike-widget">
      StatusBeam native plugin placeholder widget.
    </p>
  )
}

export const pages = { '/': MonitorsPage }
export const widgets = { status: SpikeWidget }
