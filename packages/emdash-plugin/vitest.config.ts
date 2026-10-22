import { emdashPluginTest } from '@emdash-cms/plugin-test/config'
import { defineConfig } from 'vitest/config'

// Host tests run inside workerd through EmDash's production sandbox wrapper, so
// they cannot run under `bun test`. They use the `.host.ts` suffix, which bun's
// test discovery ignores.
export default defineConfig({
  plugins: [emdashPluginTest()],
  test: {
    include: ['tests/**/*.host.ts'],
    // Each test boots a runtime host in workerd; that takes seconds on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
