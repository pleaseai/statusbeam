/**
 * The slice of `emdash` that `../block.ts` uses. `emdash` is an optional peer
 * dependency (only a site that registers the block has it), so it is not
 * installed in this monorepo's root workspace; this declaration lets the
 * package typecheck there. A site that installs `emdash` type-checks against
 * the real types, because this file is not part of the package exports.
 */
declare module 'emdash' {
  export interface PortableTextBlockConfig {
    type: string
    label: string
    icon?: string
    description?: string
    placeholder?: string
    fields?: Array<
      | { type: 'text_input', action_id: string, label: string, placeholder?: string }
      | { type: 'select', action_id: string, label: string, options: Array<{ label: string, value: string }> }
    >
  }

  export interface PluginDescriptor {
    id: string
    version: string
    entrypoint: string
    format?: 'standard' | 'native'
    componentsEntry?: string
    options?: object
  }

  export function definePlugin(definition: {
    id: string
    version: string
    admin?: { portableTextBlocks?: PortableTextBlockConfig[] }
  }): unknown
}
