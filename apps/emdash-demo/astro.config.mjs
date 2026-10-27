// ADR-0004 spike site. `SPIKE_MODE` selects the execution mode at build time:
//   worker-loader  Cloudflare Worker Loader runner (`sandbox()` from @emdash-cms/cloudflare)
//   workerd        Node host + workerd child-process runner (@emdash-cms/sandbox-workerd/sandbox)
//   in-process     Node host, probe listed in `plugins: []` (no runner, no isolation)
//   native         Node host, the native `statusbeam` plugin in `plugins: []` (no runner)
//   native-cf      Cloudflare host (workerd), the native `statusbeam` plugin in `plugins: []` (no runner)
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import cloudflare from '@astrojs/cloudflare'
import node from '@astrojs/node'
import react from '@astrojs/react'
import { d1, r2, sandbox } from '@emdash-cms/cloudflare'
import { defineConfig } from 'astro/config'
import emdash, { local } from 'emdash/astro'
import { sqlite } from 'emdash/db'
import probe from 'statusbeam-spike-probe'

const MODES = ['worker-loader', 'workerd', 'in-process', 'native', 'native-cf']
const mode = process.env.SPIKE_MODE ?? 'worker-loader'
if (!MODES.includes(mode)) {
  throw new Error(`SPIKE_MODE must be one of ${MODES.join(', ')}; got ${mode}`)
}
const onCloudflare = mode === 'worker-loader' || mode === 'native-cf'
const native = mode === 'native' || mode === 'native-cf'

// T011: `STATUSBEAM_BLOCK=1` registers the opt-in "status" Portable Text block
// from @statusbeam/emdash-ui (FR-22). Without it the site registers no
// StatusBeam plugin beyond the spike probe. The package is not installed here
// (this app is outside the root workspace), so its entry points and `emdash`
// are aliased to the sources; a real site installs the package and needs none.
// The descriptor is imported only then, so a staged copy outside the monorepo
// (scripts/stage.sh, probe spike only) builds without the package sources.
const withBlock = process.env.STATUSBEAM_BLOCK === '1'
const uiSrc = fileURLToPath(new URL('../../packages/emdash-ui/src/', import.meta.url))
const blockAlias = withBlock
  ? [
      { find: /^@statusbeam\/emdash-ui\/plugin$/, replacement: `${uiSrc}plugin.ts` },
      { find: /^@statusbeam\/emdash-ui\/astro$/, replacement: `${uiSrc}astro/index.ts` },
      { find: /^emdash$/, replacement: fileURLToPath(import.meta.resolve('emdash')) },
    ]
  : []

// T001 (native plugin track): the native modes register the StatusBeam engine
// as one native plugin from the package sources, aliased like the block above.
// `react` is deduped so the plugin's admin entry renders with the admin's copy.
const pluginSrc = fileURLToPath(new URL('../../packages/emdash-plugin/src/', import.meta.url))
const nativeAlias = native
  ? [
      { find: /^@statusbeam\/emdash-plugin\/native$/, replacement: `${pluginSrc}native.ts` },
      { find: /^@statusbeam\/emdash-plugin\/admin$/, replacement: `${pluginSrc}admin/index.tsx` },
      ...(withBlock ? [] : [{ find: /^emdash$/, replacement: fileURLToPath(import.meta.resolve('emdash')) }]),
    ]
  : []

const modeConfig = {
  'worker-loader': { sandboxed: [probe], plugins: [], sandboxRunner: mode === 'worker-loader' ? sandbox() : undefined },
  'workerd': { sandboxed: [probe], plugins: [], sandboxRunner: '@emdash-cms/sandbox-workerd/sandbox' },
  'in-process': { sandboxed: [], plugins: [probe], sandboxRunner: undefined },
  'native': { sandboxed: [], plugins: [], sandboxRunner: undefined },
  'native-cf': { sandboxed: [], plugins: [], sandboxRunner: undefined },
}[mode]
if (native) {
  const { statusbeam } = await import('../../packages/emdash-plugin/src/descriptor.ts')
  modeConfig.plugins = [statusbeam()]
}
if (withBlock) {
  const { statusBeamBlock } = await import('../../packages/emdash-ui/src/block.ts')
  modeConfig.plugins = [...modeConfig.plugins, statusBeamBlock()]
}

export default defineConfig({
  output: 'server',
  adapter: onCloudflare ? cloudflare() : node({ mode: 'standalone' }),
  integrations: [
    react(),
    emdash({
      database: onCloudflare
        ? d1({ binding: 'DB', session: 'auto', coalesce: true })
        : sqlite({ url: `file:./data-${mode}.db` }),
      storage: onCloudflare
        ? r2({ binding: 'MEDIA' })
        : local({ directory: './uploads', baseUrl: '/_emdash/api/media/file' }),
      ...modeConfig,
    }),
  ],
  vite: { resolve: { alias: [...blockAlias, ...nativeAlias], ...(native ? { dedupe: ['react', 'react-dom'] } : {}) } },
  devToolbar: { enabled: false },
})
