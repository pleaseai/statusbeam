// `public.host.ts` imports the standalone `apps/web` handlers. Their data module, which the test
// replaces, imports the Workers runtime module; this shim lets the plugin's typecheck resolve it.
declare module 'cloudflare:workers' {
  export const env: { STATUS_KV?: { get: (key: string) => Promise<string | null> } }
}
