import type { PortableTextBlockConfig } from 'emdash'
import { BLOCK_FLAVORS, BLOCK_TYPE, BLOCK_VIEWS } from './block-node'

/**
 * The "status" Portable Text block's editor definition: what the slash menu
 * offers and which fields the form has. The native plugin lists it in
 * `admin.portableTextBlocks`; the site-side renderer (`componentsEntry`) is
 * `./astro`, and the site-level options (`allowedOrigins`) are `./block-config`.
 *
 * Reads a source over HTTP: this site's own plugin routes (source type "EmDash
 * plugin") or a standalone deployment. The block type and the stored node shape
 * are unchanged from the block `@statusbeam/emdash-ui` used to register, so
 * content written with it still renders.
 */
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
