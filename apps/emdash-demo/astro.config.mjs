// ADR-0004 spike site. `SPIKE_MODE` selects the execution mode at build time:
//   worker-loader  Cloudflare Worker Loader runner (`sandbox()` from @emdash-cms/cloudflare)
//   workerd        Node host + workerd child-process runner (@emdash-cms/sandbox-workerd/sandbox)
//   in-process     Node host, probe listed in `plugins: []` (no runner, no isolation)
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

const MODES = ['worker-loader', 'workerd', 'in-process']
const mode = process.env.SPIKE_MODE ?? 'worker-loader'
if (!MODES.includes(mode)) {
  throw new Error(`SPIKE_MODE must be one of ${MODES.join(', ')}; got ${mode}`)
}
const onCloudflare = mode === 'worker-loader'

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

const modeConfig = {
  'worker-loader': { sandboxed: [probe], plugins: [], sandboxRunner: onCloudflare ? sandbox() : undefined },
  'workerd': { sandboxed: [probe], plugins: [], sandboxRunner: '@emdash-cms/sandbox-workerd/sandbox' },
  'in-process': { sandboxed: [], plugins: [probe], sandboxRunner: undefined },
}[mode]
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
  vite: { resolve: { alias: blockAlias } },
  devToolbar: { enabled: false },
})
