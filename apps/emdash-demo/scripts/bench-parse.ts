/**
 * Local CPU cost of the FR-20 per-run re-validation: `parseConfig` over the
 * 25-monitor realistic config the probe plugin uses. Run with `bun` from the
 * repo (it imports @statusbeam/core from the workspace).
 */
import process from 'node:process'
import { parseConfig } from '@statusbeam/core'
import { REALISTIC_CONFIG, REALISTIC_MONITORS } from '../probe/src/realistic-config'

const COLD = performance.now()
parseConfig(REALISTIC_CONFIG)
const coldMs = performance.now() - COLD

const ITERATIONS = 500
const started = performance.now()
for (let i = 0; i < ITERATIONS; i++) {
  parseConfig(REALISTIC_CONFIG)
}
const warmMs = (performance.now() - started) / ITERATIONS

console.log(JSON.stringify({
  monitors: REALISTIC_MONITORS,
  yamlBytes: REALISTIC_CONFIG.length,
  coldMs: Number(coldMs.toFixed(2)),
  warmMsPerParse: Number(warmMs.toFixed(3)),
  runtime: `bun ${process.versions.bun}`,
}))
