import { emdashPluginTest } from '@emdash-cms/plugin-test/config'
import { defineConfig } from 'vitest/config'

// Host tests run inside workerd through EmDash's production sandbox wrapper, so
// they cannot run under `bun test`. They use the `.host.ts` suffix, which bun's
// test discovery ignores.
export default defineConfig({
  plugins: [emdashPluginTest()],
  test: {
    include: ['tests/**/*.host.ts'],
  },
})
