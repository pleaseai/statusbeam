---
name: emdash-native-plugin-facts
description: Verified facts (emdash 1.3.1, 2026-10-27) about native vs sandboxed EmDash plugins, ctx.http.fetch/SSRF, React admin, plugin-test limits, and cheap spikes that worked
metadata:
  type: reference
---

Verified against installed `emdash@1.3.1`, `@emdash-cms/admin@1.3.1`, `@emdash-cms/plugin-test@0.2.10` (read `node_modules/emdash/src/**`, the admin ships only `dist/`).

- `createPlugin` is only a convention (generated `virtual:emdash/plugins` does `import { createPlugin } from entrypoint`, calls it with `JSON.stringify(descriptor.options)`). `definePlugin` lives in `emdash/src/plugins/define-plugin.ts`.
- Native route handler is `handler(ctx)` (single arg, ctx = PluginContext + input/request/requestMeta/user); sandboxed is `(routeCtx, ctx)`. Hooks are `(event, ctx)` in both. Raw routes must return `pluginResponse()` even when native.
- `format:'standard'` + `adminEntry`/`componentsEntry` throws in `astro/integration/index.ts` ~L560; native in `sandboxed:[]` throws.
- Native `ctx.http.fetch` = `createUnrestrictedHttpAccess` (`plugins/context.ts` ~L1262): SSRF check via DoH to cloudflare-dns.com per hop (`security/ssrf.ts`, NOT exported from `emdash`), `redirect:'manual'` max 5, full buffering, 8 MiB cap, passes `signal` through (AbortSignal.timeout works natively). `createUnrestrictedHttpAccess(pluginId, fetchImpl)` IS exported from `emdash`: a custom `fetchImpl` can time headers and cancel the body.
- Admin pages/widgets are `ComponentType` with NO props; use `apiFetch` (adds `X-EmDash-Request: 1`) + `useCurrentUser()` from `@emdash-cms/admin`. Nav/widgets are NOT role-filtered for plugins; admin styles are precompiled (`styles.css`), arbitrary Tailwind classes missing.
- `@emdash-cms/plugin-test` is sandbox-only (`emdashPluginTest()` builds via plugin-cli buildPlugin; host hardcodes `sandboxedPluginEntries`). A native plugin CAN be tested in plain Bun via `emdash/internal/plugin-test-runtime` (`EmDashRuntime.create`, `dispatchPluginApiRequest`) + `Bun.plugin build.module()` stubs for 6 `virtual:emdash/*` ids + `file::memory:` sqlite (spike script was in /tmp/sbspike, not persisted).
- Core admin supports 35 locales incl. RTL ar/fa/he (zh-CN/zh-TW, not "zh"); the track spec's "en, zh, ja, ko" is incomplete.
