/**
 * The descriptor's `adminEntry` (T001 spike placeholder). EmDash imports this
 * module into the admin bundle and looks pages up by path and widgets by id.
 * Components take no props. The admin's CSS is precompiled, so only classes the
 * admin itself uses take effect. T005 and T007 replace both components.
 */

function SpikePage() {
  return (
    <div className="space-y-4 p-6">
      <h1 className="text-2xl font-semibold">StatusBeam</h1>
      <p className="text-sm text-kumo-subtle" data-testid="statusbeam-spike-page">
        Native plugin placeholder page (T001 spike).
      </p>
    </div>
  )
}

function SpikeWidget() {
  return (
    <p className="p-4 text-sm text-kumo-subtle" data-testid="statusbeam-spike-widget">
      StatusBeam native plugin placeholder widget.
    </p>
  )
}

export const pages = { '/': SpikePage }
export const widgets = { status: SpikeWidget }
