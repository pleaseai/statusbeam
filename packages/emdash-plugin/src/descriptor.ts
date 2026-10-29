import type { PluginDescriptor } from 'emdash'
import type { StatusBlockOptions } from './block-config'
import pkg from '../package.json' with { type: 'json' }
import { parseAllowedOrigins } from './block-node'

/**
 * The plugin id. It fixes the public route base `/_emdash/api/plugins/statusbeam`
 * (`EMDASH_ROUTE_BASE` in `@statusbeam/core`'s contract).
 */
export const PLUGIN_ID = 'statusbeam'

/**
 * Options the site passes to {@link statusbeam}; JSON-serializable, handed to
 * `createPlugin`. `allowedOrigins` restricts every Status block to those origins.
 */
export type StatusBeamOptions = StatusBlockOptions

/**
 * The descriptor a site passes in the `plugins` array of the `emdash()`
 * integration. Native format: `adminEntry` (the React admin page and widget) and
 * `componentsEntry` (the Status block's site-side renderer) are native-only, so
 * the plugin cannot be sandboxed. An `allowedOrigins` entry that is not an
 * http(s) origin throws here, so a typo fails the site build.
 *
 * This module imports `emdash` for types only, so a site's `astro.config` can
 * load it without bundling the plugin runtime.
 */
export function statusbeam(options: StatusBeamOptions = {}): PluginDescriptor {
  const allowed = options.allowedOrigins === undefined ? undefined : parseAllowedOrigins(options.allowedOrigins)
  if (allowed && !allowed.ok) {
    throw new Error(`statusbeam: ${allowed.reason}`)
  }
  return {
    id: PLUGIN_ID,
    version: pkg.version,
    format: 'native',
    entrypoint: '@statusbeam/emdash-plugin/plugin',
    adminEntry: '@statusbeam/emdash-plugin/admin',
    componentsEntry: '@statusbeam/emdash-plugin/astro',
    options: allowed ? { ...options, allowedOrigins: allowed.origins } : options,
  }
}
