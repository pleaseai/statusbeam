import { dirname, resolve } from 'node:path'
import { describe, expect, it, mock } from 'bun:test'

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

describe('entry graphs (FR-22, NFR-1)', () => {
  it.each(['./index.ts', './client.ts'])('%s never reaches the block, the renderer or emdash', async (entry) => {
    const { files, bare } = await entryGraph(entry)
    const names = [...files].map(f => f.slice(import.meta.dir.length + 1))
    expect(names).toContain(entry.slice(2))
    expect(names.filter(n => ['block.ts', 'plugin.ts', 'block-node.ts'].includes(n) || n.startsWith('astro/') || n.startsWith('types/'))).toEqual([])
    expect([...bare].filter(s => s === 'emdash' || s.startsWith('emdash/') || s.startsWith('@statusbeam/emdash-ui'))).toEqual([])
  })

  it('the components graph is non-trivial, so the scan is not vacuous', async () => {
    const { files } = await entryGraph('./index.ts')
    expect([...files].some(f => f.endsWith('StatusBanner.astro'))).toBe(true)
  })
})

describe('block entry point', () => {
  it('descriptor is native and names the plugin and renderer entries', async () => {
    const { statusBeamBlock } = await import('./block')
    expect(statusBeamBlock()).toMatchObject({
      id: 'statusbeam-status-block',
      format: 'native',
      entrypoint: '@statusbeam/emdash-ui/plugin',
      componentsEntry: '@statusbeam/emdash-ui/astro',
    })
  })

  it('plugin declares only admin.portableTextBlocks (no hooks, routes, storage, cron)', async () => {
    // `emdash` is an optional peer, not installed in the root workspace: stub the
    // one function used so the shape handed to it can be asserted.
    mock.module('emdash', () => ({ definePlugin: (definition: unknown) => definition }))
    const { createPlugin } = await import('./plugin')
    const plugin = createPlugin() as unknown as Record<string, unknown>
    expect(Object.keys(plugin).sort()).toEqual(['admin', 'id', 'version'])
    const admin = plugin.admin as { portableTextBlocks: Array<{ type: string, fields: Array<{ action_id: string }> }> }
    expect(Object.keys(admin)).toEqual(['portableTextBlocks'])
    expect(admin.portableTextBlocks).toHaveLength(1)
    expect(admin.portableTextBlocks[0]!.type).toBe('statusbeam-status')
    expect(admin.portableTextBlocks[0]!.fields.map(f => f.action_id)).toEqual(['view', 'slug', 'baseUrl', 'flavor'])
  })
})

describe('allowedOrigins reach the renderer', () => {
  it('the descriptor carries normalised origins as options, none when unset, and throws on a bad entry', async () => {
    const { statusBeamBlock } = await import('./block')
    expect(statusBeamBlock()).not.toHaveProperty('options')
    expect(statusBeamBlock({ allowedOrigins: ['HTTPS://Status.Example.com:443/'] }).options).toEqual({ allowedOrigins: ['https://status.example.com'] })
    expect(() => statusBeamBlock({ allowedOrigins: ['https://status.example.com/prefix'] })).toThrow('statusBeamBlock: allowedOrigins entry "https://status.example.com/prefix"')
  })

  it('createPlugin(options) is what StatusBlock.astro validates blocks with', async () => {
    mock.module('emdash', () => ({ definePlugin: (definition: unknown) => definition }))
    const { statusBeamBlock } = await import('./block')
    const { createPlugin } = await import('./plugin')
    const { renderOptions } = await import('./block-config')
    const { selectFromBlock } = await import('./block-node')
    try {
      // EmDash inlines the descriptor's options as JSON into its generated plugins module.
      createPlugin(JSON.parse(JSON.stringify(statusBeamBlock({ allowedOrigins: ['https://status.example.com'] }).options)))
      expect(renderOptions(false)).toEqual({ allowPrivateHosts: false, allowedOrigins: ['https://status.example.com'] })
      expect(selectFromBlock({ baseUrl: 'https://status.example.com' }, renderOptions(false))).toMatchObject({ ok: true })
      expect(selectFromBlock({ baseUrl: 'https://internal.corp' }, renderOptions(false))).toMatchObject({ ok: false, reason: expect.stringContaining('allowed origins') })

      createPlugin(JSON.parse(JSON.stringify(statusBeamBlock().options ?? {})))
      expect(renderOptions(true)).toEqual({ allowPrivateHosts: true })
    }
    finally {
      createPlugin()
    }
    const renderer = await Bun.file(resolve(import.meta.dir, 'astro/StatusBlock.astro')).text()
    expect(renderer).toContain('selectFromBlock(Astro.props.node ?? {}, renderOptions(import.meta.env.DEV))')
  })
})
