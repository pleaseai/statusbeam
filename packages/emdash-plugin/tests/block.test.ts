import { dirname, resolve } from 'node:path'
import { describe, expect, it, mock } from 'bun:test'

const SRC = resolve(import.meta.dir, '../src')
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

/** The bare specifiers reachable from `entry` through its relative imports. */
async function bareImports(entry: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const queue = [resolve(SRC, entry)]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const m of (await Bun.file(file).text()).matchAll(IMPORT)) {
      const specifier = (m[1] ?? m[2] ?? m[3])!
      if (specifier.startsWith('.')) {
        queue.push(await resolveRelative(file, specifier))
      }
      else {
        bare.add(specifier)
      }
    }
  }
  return bare
}

/**
 * Stub the one `emdash` function the plugin uses, so the shape handed to it can
 * be asserted. `mock.module` is process-wide under `bun test`, so the stub keeps
 * the rest of `emdash` for other test files that import it.
 */
async function stubDefinePlugin(): Promise<void> {
  const real = await import('emdash')
  mock.module('emdash', () => ({ ...real, definePlugin: (definition: unknown) => definition }))
}

describe('status block descriptor', () => {
  it('the one native descriptor names the plugin, the admin entry and the block renderer', async () => {
    const { statusbeam } = await import('../src/descriptor')
    expect(statusbeam()).toMatchObject({
      id: 'statusbeam',
      format: 'native',
      entrypoint: '@statusbeam/emdash-plugin/plugin',
      adminEntry: '@statusbeam/emdash-plugin/admin',
      componentsEntry: '@statusbeam/emdash-plugin/astro',
    })
  })

  it('carries normalised allowedOrigins as JSON options, none when unset, and throws on a bad entry', async () => {
    const { statusbeam } = await import('../src/descriptor')
    expect(statusbeam().options).toEqual({})
    expect(statusbeam({ allowedOrigins: ['HTTPS://Status.Example.com:443/'] }).options).toEqual({ allowedOrigins: ['https://status.example.com'] })
    expect(() => statusbeam({ allowedOrigins: ['https://status.example.com/prefix'] })).toThrow('statusbeam: allowedOrigins entry "https://status.example.com/prefix"')
  })
})

describe('status block registration', () => {
  it('the native plugin lists the statusbeam-status block next to its pages and widget', async () => {
    await stubDefinePlugin()
    const { createPlugin } = await import('../src/native')
    const plugin = createPlugin() as unknown as { admin: { entry: string, pages: unknown[], portableTextBlocks: Array<{ type: string, fields: Array<{ action_id: string }> }> } }
    expect(plugin.admin.entry).toBe('@statusbeam/emdash-plugin/admin')
    expect(plugin.admin.portableTextBlocks).toHaveLength(1)
    expect(plugin.admin.portableTextBlocks[0]!.type).toBe('statusbeam-status')
    expect(plugin.admin.portableTextBlocks[0]!.fields.map(f => f.action_id)).toEqual(['view', 'slug', 'baseUrl', 'flavor'])
  })

  it('createPlugin(options) is what StatusBlock.astro validates blocks with', async () => {
    await stubDefinePlugin()
    const { statusbeam } = await import('../src/descriptor')
    const { createPlugin } = await import('../src/native')
    const { renderOptions } = await import('../src/block-config')
    const { selectFromBlock } = await import('../src/block-node')
    try {
      // EmDash inlines the descriptor's options as JSON into its generated plugins module.
      createPlugin(JSON.parse(JSON.stringify(statusbeam({ allowedOrigins: ['https://status.example.com'] }).options)))
      expect(renderOptions(false)).toEqual({ allowPrivateHosts: false, allowedOrigins: ['https://status.example.com'] })
      expect(selectFromBlock({ baseUrl: 'https://status.example.com' }, renderOptions(false))).toMatchObject({ ok: true })
      expect(selectFromBlock({ baseUrl: 'https://internal.corp' }, renderOptions(false))).toMatchObject({ ok: false, reason: expect.stringContaining('allowed origins') })

      createPlugin(JSON.parse(JSON.stringify(statusbeam().options ?? {})))
      expect(renderOptions(true)).toEqual({ allowPrivateHosts: true })

      // `createPlugin` is a published entry, so options can skip `statusbeam`'s validation.
      createPlugin({ allowedOrigins: {} as unknown as string[] })
      expect(selectFromBlock({ baseUrl: 'https://internal.corp' }, renderOptions(false))).toEqual({ ok: false, reason: 'allowedOrigins must be an array of origins' })
    }
    finally {
      createPlugin()
    }
    const renderer = await Bun.file(resolve(SRC, 'astro/StatusBlock.astro')).text()
    expect(renderer).toContain('selectFromBlock(Astro.props.node ?? {}, renderOptions(import.meta.env.DEV))')
    expect(renderer).toContain('const options = blockFetchOptions()')
    expect(renderer).toContain('fetchStatus(selection.source, options)')
    expect(renderer).toContain('fetchSite(selection.source, selection.slug, options)')
  })
})

describe('block renderer', () => {
  it('imports the library components from @statusbeam/emdash-ui and registers the block type', async () => {
    const renderer = await Bun.file(resolve(SRC, 'astro/StatusBlock.astro')).text()
    const libraryImport = renderer.split('\n').find(line => line.endsWith('from \'@statusbeam/emdash-ui\'')) ?? ''
    for (const name of ['SiteDetail', 'StatusBanner', 'UnavailableNotice', 'fetchStatus', 'fetchSite']) {
      expect(libraryImport, name).toContain(name)
    }
    expect([...await bareImports('astro/index.ts')]).toContain('@statusbeam/emdash-ui')
    const { blockComponents } = await import('../src/astro/index') as { blockComponents: Record<string, unknown> }
    expect(Object.keys(blockComponents)).toEqual(['statusbeam-status'])
  })

  it('the plugin lists @statusbeam/emdash-ui in dependencies', async () => {
    const pkg = await Bun.file(resolve(SRC, '../package.json')).json() as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@statusbeam/emdash-ui']).toBe('workspace:*')
  })
})
