// `StatusBlock.astro` is compiled by the site's Astro build; this lets the plugin's typecheck resolve the import.
declare module '*.astro' {
  const component: (props: Record<string, unknown>) => unknown
  export default component
}
