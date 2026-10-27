import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

const IMPORT = /\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm

async function resolveRelative(from: string, specifier: string): Promise<string> {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.astro`, `${base}/index.ts`]) {
    const isFile = await Bun.file(candidate).stat().then(s => s.isFile(), () => false)
    if (isFile) {
      return candidate
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`)
}

/** Every file and bare specifier reachable from `entry` through its imports. */
async function entryGraph(entry: string): Promise<{ files: Set<string>, bare: Set<string> }> {
  const files = new Set<string>()
  const bare = new Set<string>()
  const queue = [resolve(import.meta.dir, entry)]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) {
      continue
    }
    files.add(file)
    const text = await Bun.file(file).text()
    for (const m of text.matchAll(IMPORT)) {
      const specifier = (m[1] ?? m[2] ?? m[3])!
      if (specifier.startsWith('.')) {
        if (!specifier.endsWith('.css')) {
          queue.push(await resolveRelative(file, specifier))
        }
      }
      else {
        bare.add(specifier)
      }
    }
  }
  return { files, bare }
}

describe('entry graphs (FR-22, NFR-1, FR-11)', () => {
  it.each(['./index.ts', './client.ts'])('%s never reaches emdash or any block or plugin module', async (entry) => {
    const { files, bare } = await entryGraph(entry)
    const names = [...files].map(f => f.slice(import.meta.dir.length + 1))
    expect(names).toContain(entry.slice(2))
    expect(names.filter(n => /(?:^|\/)(?:block|plugin)[^/]*\.ts$/.test(n) || n.startsWith('astro/') || n.startsWith('types/'))).toEqual([])
    expect([...bare].filter(s => s === 'emdash' || s.startsWith('emdash/') || s.startsWith('@statusbeam/emdash-'))).toEqual([])
  })

  it('the components graph is non-trivial, so the scan is not vacuous', async () => {
    const { files } = await entryGraph('./index.ts')
    expect([...files].some(f => f.endsWith('StatusBanner.astro'))).toBe(true)
  })

  it('the package exports components and the client only, with no emdash peer', async () => {
    const pkg = await Bun.file(resolve(import.meta.dir, '../package.json')).json() as {
      exports: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(Object.keys(pkg.exports)).toEqual(['.', './client'])
    expect(Object.keys(pkg.peerDependencies ?? {})).not.toContain('emdash')
  })
})
