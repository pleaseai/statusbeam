import type { ReactNode } from 'react'
import { Banner } from '@cloudflare/kumo'
import { useCurrentUser } from '@emdash-cms/admin'
import { useAdminDict } from './i18n'

/** The role level of an administrator. The host gates the private routes with `plugins:manage`, which only an administrator holds. */
export const ADMIN_ROLE = 50

/**
 * Renders `children` for an administrator only.
 *
 * The host does not role-gate a plugin's pages or widgets, so each component
 * refuses everyone else itself. `children` is not mounted until the user is
 * known to be an administrator, so a non-admin's browser never requests the
 * configuration.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const t = useAdminDict()
  const user = useCurrentUser()
  if (user.isPending) {
    return <p className="p-6 text-sm text-kumo-subtle" role="status">{t.loading}</p>
  }
  if (user.isError) {
    return <div className="p-6"><Banner variant="error" description={t.loadFailed} role="alert" /></div>
  }
  if (!user.data || user.data.role < ADMIN_ROLE) {
    return <div className="p-6"><Banner variant="error" description={t.forbidden} role="alert" /></div>
  }
  return <>{children}</>
}
