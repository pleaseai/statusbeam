import { definePlugin } from 'emdash'
import pkg from '../package.json' with { type: 'json' }
import { PLUGIN_ID, statusBlock } from './block'

/**
 * The descriptor's `entrypoint`: EmDash imports `createPlugin` from here and
 * calls it with the descriptor's `options`. The plugin declares only the
 * "status" block in `admin.portableTextBlocks`.
 */
export function createPlugin() {
  return definePlugin({
    id: PLUGIN_ID,
    version: pkg.version,
    admin: { portableTextBlocks: [statusBlock] },
  })
}
