import type { SelectOptions } from './block-node'

/**
 * The site-level options of the "status" block, and how they reach the renderer.
 *
 * EmDash hands a native descriptor's `options` only to the entrypoint's
 * `createPlugin(options)`, inlined as JSON into the generated
 * `virtual:emdash/plugins` module; it imports the `componentsEntry` bare and
 * passes the block component only the block's data. That plugins module is a
 * static import of `emdash/middleware`, which the integration always installs,
 * so `createPlugin` has run before any page renders inside it. `createPlugin`
 * records the options here and the renderer reads them at render time.
 *
 * The record lives on `globalThis` under a registry symbol, not in a module
 * variable, so it survives Vite SSR loading this module twice.
 */
export interface StatusBlockOptions {
  /** Origins a block may fetch; see `SelectOptions.allowedOrigins`. */
  allowedOrigins?: string[]
}

const KEY = Symbol.for('@statusbeam/emdash-plugin/block-options')

type Registry = typeof globalThis & { [KEY]?: StatusBlockOptions }

/** Record the options the descriptor carried. Called by `createPlugin`. */
export function setBlockOptions(options: StatusBlockOptions): void {
  (globalThis as Registry)[KEY] = { ...options }
}

/** The options to validate a block with when rendering it. */
export function renderOptions(dev: boolean): SelectOptions {
  const { allowedOrigins } = (globalThis as Registry)[KEY] ?? {}
  return allowedOrigins === undefined ? { allowPrivateHosts: dev } : { allowPrivateHosts: dev, allowedOrigins }
}
