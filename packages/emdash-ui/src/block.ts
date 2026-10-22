import type { PluginDescriptor, PortableTextBlockConfig } from 'emdash'
import pkg from '../package.json' with { type: 'json' }
import { BLOCK_FLAVORS, BLOCK_TYPE, BLOCK_VIEWS } from './block-node'

/**
 * Opt-in native plugin descriptor for a "status" Portable Text block.
 *
 * A site registers it with `plugins: [statusBeamBlock()]` in its `emdash()`
 * integration config. It is the only StatusBeam code registered as an EmDash
 * plugin, and it declares only `admin.portableTextBlocks`: no hooks, routes,
 * storage, capabilities or cron. A site that only imports the components from
 * the package root registers nothing.
 *
 * This module imports `emdash` for types only, so a site's `astro.config` can
 * load it without bundling the plugin runtime. The plugin itself (the
 * `entrypoint`, which calls `definePlugin`) is `./plugin`; the site-side
 * renderer (`componentsEntry`) is `./astro`. Native format is required because
 * `componentsEntry` is native-only, so the plugin cannot be sandboxed.
 */
export const PLUGIN_ID = 'statusbeam-status-block'

/** The editor definition: what the slash menu offers and which fields the form has. */
export const statusBlock: PortableTextBlockConfig = {
  type: BLOCK_TYPE,
  label: 'Status',
  icon: 'link-external',
  description: 'Embed the StatusBeam overall status or one site.',
  fields: [
    {
      type: 'select',
      action_id: 'view',
      label: 'View',
      options: BLOCK_VIEWS.map(value => ({ label: value === 'site' ? 'Site detail' : 'Overall banner', value })),
    },
    { type: 'text_input', action_id: 'slug', label: 'Site slug (site detail only)', placeholder: 'api' },
    { type: 'text_input', action_id: 'baseUrl', label: 'Status source URL', placeholder: 'https://status.example.com' },
    {
      type: 'select',
      action_id: 'flavor',
      label: 'Source type',
      options: BLOCK_FLAVORS.map(value => ({ label: value === 'emdash' ? 'EmDash plugin' : 'Standalone', value })),
    },
  ],
}

/** The descriptor to pass in the `plugins` array of the `emdash()` integration. */
export function statusBeamBlock(): PluginDescriptor {
  return {
    id: PLUGIN_ID,
    version: pkg.version,
    format: 'native',
    entrypoint: '@statusbeam/emdash-ui/plugin',
    componentsEntry: '@statusbeam/emdash-ui/astro',
  }
}
