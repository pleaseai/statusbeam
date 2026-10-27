/**
 * The descriptor's `adminEntry`. EmDash imports this module into the admin
 * bundle and looks pages up by path and widgets by id. Components take no
 * props, and the host does not role-gate them: each refuses a non-administrator
 * itself (see `AdminGate`). The admin's CSS is precompiled, so only classes the
 * admin itself uses take effect, and layout uses logical properties for RTL.
 */
import { MonitorsPage } from './MonitorsPage'
import { StatusPage } from './StatusPage'
import { StatusWidget } from './StatusWidget'

export const pages = { '/': StatusPage, '/monitors': MonitorsPage }
export const widgets = { status: StatusWidget }
