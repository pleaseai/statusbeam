import { Buffer } from 'node:buffer'
import process from 'node:process'
import { plugin } from 'bun'

/**
 * Preload for the native host tests. The EmDash runtime imports six
 * `virtual:emdash/*` modules that Astro's Vite integration generates; outside
 * Astro each gets the stub below (no scheduler, no config, no object cache).
 * Registered process-wide, so the host tests run in their own `bun test` call.
 */
const stubs: Record<string, string> = {
  'virtual:emdash/wait-until': 'export const waitUntil = undefined;',
  'virtual:emdash/scheduler': 'export const createScheduler = null;',
  'virtual:emdash/config': 'export default {};',
  'virtual:emdash/env': 'export const env = undefined;',
  'virtual:emdash/build': 'export const buildTime = 0;',
  'virtual:emdash/object-cache': 'export const createObjectCacheBackend = null;',
}

plugin({
  name: 'emdash-virtual-modules',
  setup(build) {
    for (const [id, contents] of Object.entries(stubs)) {
      build.module(id, () => ({ contents, loader: 'js' }))
    }
  },
})

// Plugin secret settings are encrypted; the host reads the key from the environment.
process.env.EMDASH_ENCRYPTION_KEY ??= `emdash_enc_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
