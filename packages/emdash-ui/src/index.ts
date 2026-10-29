/**
 * `@statusbeam/emdash-ui`: Astro status components for an EmDash (or any
 * Astro) site, rendered from the StatusBeam public JSON of either a standalone
 * deployment or the EmDash plugin.
 *
 * This is a plain component library, not an EmDash plugin: no hooks, cron,
 * storage or check engine. It only reads the public contract. The Portable Text
 * "status" block that renders these components lives in `@statusbeam/emdash-plugin`.
 */
export type {
  Available,
  FetchOptions,
  SiteInput,
  StatusInput,
  StatusResult,
  StatusSource,
  Unavailable,
  UnavailableReason,
} from './client'
export { DEFAULT_TIMEOUT_MS, fetchSite, fetchStatus, siteUrl, statusUrl } from './client'
export { default as SiteDetail } from './components/SiteDetail.astro'
export { default as StatusBanner } from './components/StatusBanner.astro'
export { default as UnavailableNotice } from './components/Unavailable.astro'
export { default as UptimeBars } from './components/UptimeBars.astro'
export type { RouteFlavor } from '@statusbeam/core/contract'
