/**
 * Route names of the private admin routes, mounted under
 * `/_emdash/api/plugins/statusbeam/`. Import-free: the server routes
 * (`routes/admin.ts`) and the browser client (`admin/api.ts`) share it.
 */
export const ADMIN_ROUTE = {
  config: 'admin/config',
  validate: 'admin/validate',
  save: 'admin/save',
  test: 'admin/test',
  overview: 'admin/overview',
} as const
