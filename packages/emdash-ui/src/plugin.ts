import type { StatusBlockOptions } from './block-config'
import { definePlugin } from 'emdash'
import pkg from '../package.json' with { type: 'json' }
import { PLUGIN_ID, statusBlock } from './block'
import { setBlockOptions } from './block-config'

/**
 * The descriptor's `entrypoint`: EmDash imports `createPlugin` from here and
 * calls it with the descriptor's `options`. The plugin declares only the
 * "status" block in `admin.portableTextBlocks`, and records the options for
 * the renderer (see `./block-config`).
 */
export function createPlugin(options: StatusBlockOptions = {}) {
  setBlockOptions(options)
  return definePlugin({
    id: PLUGIN_ID,
    version: pkg.version,
    admin: { portableTextBlocks: [statusBlock] },
  })
}
