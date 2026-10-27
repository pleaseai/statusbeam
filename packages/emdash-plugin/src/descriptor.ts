import type { PluginDescriptor } from 'emdash'
import pkg from '../package.json' with { type: 'json' }

/**
 * The plugin id. It fixes the public route base `/_emdash/api/plugins/statusbeam`
 * (`EMDASH_ROUTE_BASE` in `@statusbeam/core`'s contract).
 */
export const PLUGIN_ID = 'statusbeam'

/** Options the site passes to {@link statusbeam}; JSON-serializable, handed to `createPlugin`. */
export type StatusBeamOptions = Record<string, never>

/**
 * The descriptor a site passes in the `plugins` array of the `emdash()`
 * integration. Native format: `adminEntry` (the React admin page and widget) is
 * native-only, so the plugin cannot be sandboxed.
 *
 * This module imports `emdash` for types only, so a site's `astro.config` can
 * load it without bundling the plugin runtime.
 */
export function statusbeam(options: StatusBeamOptions = {}): PluginDescriptor {
  return {
    id: PLUGIN_ID,
    version: pkg.version,
    format: 'native',
    entrypoint: '@statusbeam/emdash-plugin/native',
    adminEntry: '@statusbeam/emdash-plugin/admin',
    options,
  }
}
