# Plan: StatusBeam as a single native EmDash plugin with a React admin page

> Track: emdash-native-plugin-20261027
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: emdash-native-plugin-20261027
- **Issue**: #110
- **Created**: 2026-10-27
- **Approach**: Rewrite `packages/emdash-plugin` in place as one native plugin that keeps the engine's portable logic, drops the sandbox-only code, adds a React admin entry, and takes over the Portable Text block
- **Plan Depth**: deep
- **Planned At**: 790a7ec

## Context

### Problem

Most of the engine is already host-independent: probes go through core `checkSite` with an injected
fetch, and `DayBucket` is the standalone `GROUP BY` shape feeding core's rollup (`src/buckets.ts:11-15`),
so AC-006 parity reuses existing code. Sandbox-only code: `src/budget.ts`, sharding and handoff in
`src/shards.ts` / `src/snapshot.ts`, the call counters in `src/run.ts` and `src/routes/webhooks.ts`,
the `limit: 'body'` workaround in `src/probe.ts`, and `src/admin-view.ts`.

EmDash 1.3.1 facts the design rests on (source-read and Bun spike):

- `definePlugin()` takes the same hooks, routes, storage, and admin fields as a sandboxed plugin, but
  route handlers take one argument. The site registers it in `plugins: []` through a descriptor whose
  `entrypoint` exports a named `createPlugin(options)`.
- The host gates private routes with `plugins:manage` (Admin only) and `X-EmDash-Request`, but does
  **not** role-gate plugin nav items or widgets, so the React components refuse non-admins themselves.
- `plugin:activate` runs once per install, so it cannot keep the schedule repaired.
- `@emdash-cms/plugin-test` loads sandboxed plugins only; `emdash/internal/plugin-test-runtime` ran a
  native plugin end to end under Bun.
- The admin's CSS is precompiled: a Tailwind class it does not already use renders unstyled.

### Non-Goals

Spec Out of Scope applies. Considered and not built:

- An in-process block renderer. The block keeps today's HTTP read (FR-11); a host API for plugin data in Astro components would change this.
- Lingui catalogs for StatusBeam strings. Core's `getDict` covers NFR-1's four locales; an EmDash rule requiring Lingui would change this.

### STOP Conditions

- The header-time fetch fails on workerd or Node, or loses the host SSRF check (T001). FR-2, AC-003–005, and NFR-4 go back to the user.
- The React admin entry cannot load as shipped TypeScript source in the Node or Cloudflare build (T001).

## Architecture Decision

**One native plugin, rewritten in place.** Package `@statusbeam/emdash-plugin`, id `statusbeam`, so
`EMDASH_ROUTE_BASE` (`packages/core/src/contract.ts:140`) and every public route path stay. Exports:
`statusbeam(options)` (the site's descriptor), `./plugin`, `./admin`, `./astro`. It ships TypeScript
source with no build step, like `@statusbeam/emdash-ui`.

**One scheduled task for every monitor.** A 5-minute `check` task probes all monitors concurrently,
each under its own deadline, plus a daily `maintenance` prune. Both tasks and every save reconcile the
schedule. State collapses to one KV snapshot; poll and webhook bucket rows stay separate because a run
and a webhook can still write at once.

**Header-time probing behind the host's guard.** HTTP checks use the exported
`createUnrestrictedHttpAccess('statusbeam', headerOnlyFetch)`, where `headerOnlyFetch` resolves at
headers and cancels the body. The host keeps its DNS-aware SSRF check and 5-hop redirect cap. Under Bun
this measured 1 ms to headers where the body took 3 s, passed a 9 MiB body, and still blocked
169.254.169.254; it is an undocumented export, unverified on workerd and Node (T001). Body-reading
checkers (Sentry, AI Gateway) use the normal `ctx.http.fetch`.

**Config stays YAML text under the `config` setting**, with its revision-checked `compareAndSet`. The
editor works on the parsed object; the server serializes, validates with core plus plugin rules, and
returns issues with field paths. Secrets stay in `settingsSchema`, edited on EmDash's generated settings
page; the admin page shows only `secretsSet` (AC-010).

**Rejected:** a sandboxed engine plus a native admin-only plugin; running the sandboxed bundle in-process
(`format: "standard"` cannot carry `adminEntry` or `componentsEntry`); a structured store replacing the
YAML (breaks the single schema with standalone); our own SSRF check around global `fetch` (a weaker copy
of the host's).

## Tasks

- [x] T001 [SPIKE] Prove the native plugin shape in the demo site (file: packages/emdash-plugin/src/plugin.ts) [FR-1, FR-2, AC-001]
  Validation: `apps/emdash-demo` registers a native `statusbeam` plugin in `plugins: []` with no sandbox runner, in both the Node and the Cloudflare dev builds. In each, a placeholder React page renders, a scheduled task fires, and a header-only probe reports header-time latency on a slow-body fixture while 127.0.0.1 and 169.254.169.254 are refused.
  Method: run the demo site in each mode and record the outputs; `Skill("please:test-browser")` on the admin page
  STOP: either build fails one of these checks — report before T002.
- [ ] T002 Run every monitor from one native scheduled task (file: packages/emdash-plugin/src/run.ts) (depends on T001) [FR-1, FR-2, FR-3, FR-6, NFR-2, NFR-4, AC-002, AC-003, AC-004, AC-005, AC-006, AC-013]
  Validation: one run checks all of 12 monitors; a slow body is timed to headers; a body over 8 MiB is graded by status code; a hung response is `down` at the deadline while the rest finish; a private address is refused, also behind a redirect; a removed monitor is not checked next run; a status change sends one Slack and one generic webhook notification and an unchanged status sends none; the plugin and the standalone rollup give identical 90-day figures for the same results.
  Method: `bun test` plus native host tests on `emdash/internal/plugin-test-runtime`, replacing the vitest/workerd harness; the CI "Plugin host tests" step switches to them in the same change so CI stays green
- [ ] T003 Serve public and webhook routes from the native plugin (file: packages/emdash-plugin/src/routes/webhooks.ts) (depends on T002) [FR-4, FR-5, NFR-2, AC-007, AC-008, AC-009]
  Validation: status, per-site, and badge routes keep their paths and cache header and parse with core's contract schemas; a never-checked monitor carries `pending: true`; webhooks keep the 405 → 401 → 404 → 400 → 204/200 order, refuse everything while `webhookSecret` is unset, and return 401 for a token of the wrong length or with non-ASCII characters.
  Method: native host tests through `dispatchPluginApiRequest`
- [ ] T004 Expose admin-only config, validate, save, test, and overview routes (file: packages/emdash-plugin/src/admin.ts) (depends on T002) [FR-7, FR-9, FR-10, NFR-2, NFR-4, AC-010, AC-016]
  Validation: every admin route gives 401 to anonymous callers, 403 to editors, and refuses a cookie POST without `X-EmDash-Request`; validate returns issues with field paths (such as `sites[2].url`); a stale-revision save writes nothing and returns the current config; a save reconciles the schedule; test writes no bucket, snapshot, or delivery; test refuses a loopback, private, or cloud-metadata URL, also behind a redirect; no response contains a secret value.
  Method: native host tests for each route and role
- [ ] T005 Edit monitors from a React admin page (file: packages/emdash-plugin/src/admin/MonitorsPage.tsx) (depends on T004) [FR-7, FR-10, NFR-1, AC-010, AC-011, AC-012, AC-016]
  Validation: an administrator can add, edit, and remove monitors and save. An invalid field, including a duplicate slug, shows its error next to that field and nothing is saved. Renaming a slug saves it as a new monitor. A stale save shows the newer config. Each secret shows only "set" or "not set", with a link to the plugin settings page. A non-admin sees a refusal and no config. Text uses core's dictionary in en/zh/ja/ko with English otherwise, and the layout holds in an RTL locale.
  Method: component tests with a mocked `apiFetch`; `Skill("please:test-browser")` on the demo admin in `en` and `ar`
- [ ] T006 Test one monitor on demand from the editor (file: packages/emdash-plugin/src/admin/TestMonitor.tsx) (depends on T005) [FR-9, AC-015, AC-019]
  Validation: testing a monitor shows its status, latency, and response code, including an unsaved edit. History, the snapshot, and notifications are unchanged afterwards.
  Method: component test plus the T004 route test; browser check on the demo admin
- [ ] T007 Show the status overview page and dashboard widget (file: packages/emdash-plugin/src/admin/StatusPage.tsx) (depends on T004) [FR-8, FR-10, NFR-1, AC-014, AC-016]
  Validation: the overview lists every monitor with its status, 90-day bars, and latest latency. A never-checked monitor reads "Not checked yet" with no uptime figure. The widget summarizes overall status. Both refuse non-admins.
  Method: component tests; `Skill("please:test-browser")` on the demo dashboard and page
- [ ] T008 Move the status Portable Text block into the plugin (file: packages/emdash-plugin/src/block.ts) (depends on T001) [FR-11, AC-017]
  Validation: an editor can insert the `statusbeam-status` block and the published page shows that monitor's status, with the source choice (this plugin or a standalone deployment) and the `allowedOrigins` allowlist behaving as before: a `baseUrl` outside the allowlist or carrying credentials is refused before any fetch. `@statusbeam/emdash-ui` exports components and the client only, with no `./plugin`, `./block`, or `./astro` and no `emdash` peer. The plugin lists `@statusbeam/emdash-ui` in `dependencies`, since its block renderer imports the library's components.
  Method: the ported `block-node.test.ts` and a rewritten `entry-graph.test.ts`; browser check of a published page in the demo
- [ ] T009 Ship the package as a native-only plugin (file: packages/emdash-plugin/package.json) (depends on T003, T008) [FR-12, AC-018]
  Validation: the package exposes `.`, `./plugin`, `./admin`, `./astro` and no sandboxed entry. `emdash-plugin.jsonc` and the plugin CLI are gone. `publish.yml` gates on the native host tests instead of `test:host`. The demo site registers the plugin through `statusbeam()`. The `emdash` peer range is pinned to `~1.3.1`, the line `createUnrestrictedHttpAccess` and `emdash/internal/plugin-test-runtime` were verified on. `publish.yml` waits for the `@statusbeam/emdash-ui` version the plugin pins, as it does for core.
  Method: `bun run build && bun run typecheck && bun test` at the root; CI green on the PR
- [ ] T010 Record ADR-0005 and update the EmDash docs (file: docs/adr/0005-emdash-native-plugin.md) (depends on T006, T007, T008, T009) [FR-13, NFR-3]
  Validation: ADR-0005 passes doc-lint and states the native-plugin decision, the rejected alternatives, and the parts of ADR-0004 it keeps (the component library and the core-owned wire contract). ADR-0004's status reads "Superseded by ADR-0005" with its body untouched, and the ADR index matches. The EmDash guide shows the `plugins: []` install as a trusted dependency and says a plugin-hosted page goes down with the CMS.
  Method: doc-lint on the new ADR (`Skill("standards:doc-lint")`); docs site build (`Skill("run-docs")`)

## Key Files

- `packages/emdash-plugin/src/{plugin,run,probe,shards,snapshot,buckets,config,admin,notify,settings}.ts`, `src/routes/{public,webhooks}.ts`
- `packages/emdash-plugin/tests/fake-context.ts`, `tests/*.host.ts`, `vitest.config.ts`
- `packages/emdash-ui/src/{block,block-node,block-config,plugin,entry-graph.test}.ts`, `src/astro/{index.ts,StatusBlock.astro}`
- `packages/core/src/{check,rollup,contract,i18n}.ts`
- `apps/emdash-demo/astro.config.mjs`, `.github/workflows/{ci,publish}.yml`, `apps/docs/src/content/docs/guides/emdash.mdx`, `docs/adr/{0004-emdash-plugin-distribution,index}.md`

## Verification

### Automated Tests

- [ ] Root `bun run build`, `bun run typecheck`, and `bun test` pass
- [ ] Native host tests on `emdash/internal/plugin-test-runtime` (T002–T004) pass in CI
- [ ] Admin component tests with a mocked `apiFetch` (T005–T007) pass

### Observable Outcomes

- Every AC in spec.md maps to a task Validation above: AC-001/002/003/004/005/006/013 → T002; AC-007/008/009 → T003; AC-010/016 → T004–T007; AC-011/012 → T005; AC-014 → T007; AC-015/019 → T006; AC-017 → T008; AC-018 → T009.
- The demo site runs the plugin with no sandbox runner on Node and Cloudflare, and a browser pass covers the admin page, the widget, and a published block.

## Review Focus

- A monitor URL that redirects to a private address — T002 (refused on the redirect hop, not only the first URL).
- A webhook `token` query value of the wrong length or with Unicode — T003 (still a 401, compared in constant time).
- Monitor form input with a duplicate slug, or a slug renamed while the monitor has history — T005 (a duplicate is rejected at the field; a rename is saved as a new monitor).
- A block whose `baseUrl` is outside `allowedOrigins` or carries credentials — T008 (refused before any fetch).
- A cookie-authenticated POST to an admin route without `X-EmDash-Request` — T004 (refused by the host CSRF check).

## Progress

- [x] (2026-10-27 18:10 KST) T001 [SPIKE] Prove the native plugin shape in the demo site
  Evidence: `SPIKE_MODE=native astro dev` and `SPIKE_MODE=native-cf astro dev` (workerd, `runtime: Cloudflare-Workers`), plus `astro build` for both modes (Node build served by `node dist/server/entry.mjs`, Cloudflare build by `wrangler dev --local`) → `plugins: [statusbeam()]` with `sandboxed: []` and no runner in each. agent-browser shows the placeholder page at `/_emdash/admin/plugins/statusbeam/` and the dashboard widget (results/2026-10-27/native-{node,cf}-{page,dashboard}.png). `spike-tick` fired on Node through the `NodeCronScheduler` timer (`ranAt 08:37:00.001`), on Cloudflare dev through the 60 s dev scheduler bridge (`ranAt 08:53:40.945`), and on the Cloudflare build through `scheduled()` (`ranAt 09:01:11.393`). `spike-probe?target=slow-body-3s&body=1` → header mode `up` 837 ms (Node) / 787 ms (CF) against 3607 / 3649 ms for the buffered body. A 9 MiB body is `up` 200 in header mode and hits the 8 MiB limit in body mode. 127.0.0.1, 169.254.169.254, a 302 to 169.254.169.254, and `localhost.direct` (DNS → 127.0.0.1) are all refused by the host guard on both hosts (results/2026-10-27/native-plugin.md). `bun test` → 534 pass, 0 fail. `bun run typecheck` and `bun run build` → all tasks successful. `bun run test:host` in packages/emdash-plugin → 28 passed.
  Modules for T002: `src/descriptor.ts` (`statusbeam()`, `PLUGIN_ID`), `src/native.ts` (`createPlugin`; spike task and routes to replace), `src/http.ts` (`headerOnlyFetch`, `createProbeHttp`), and `src/admin/index.tsx` (`pages['/']`, `widgets.status`). The descriptor's spike specifiers are `@statusbeam/emdash-plugin/native` and `/admin`. Files outside `Files:`: `packages/emdash-plugin/{package.json,tsconfig.json}` and `bun.lock` (`@types/react` devDependency, `jsx`, `*.tsx` include), `packages/emdash-ui/src/entry-graph.test.ts` (its `mock.module('emdash')` stub replaced the whole module for every later test file, which broke `tests/http.test.ts` in the full suite; the stub now spreads the real module), `apps/emdash-demo/{package.json,README.md}`.

## Decision Log

- 2026-10-27: no separate architecture agents; the exploration reports settled the strategy questions. T010 merges last so it describes what shipped.
- Decision: T001 probes public third-party targets (httpbin.org `drip`/`redirect-to`, speed.cloudflare.com `__down`, `localhost.direct`) instead of the ADR-0004 fixture Worker.
  Rationale: the fixture Worker was deleted on 2026-10-22 (its URLs return 404), and the task forbids deploying one. The targets are fixed in `SPIKE_TARGETS`.
  Date/Author: 2026-10-27 / implement-executor
- Decision: the spike descriptor's entrypoint is `@statusbeam/emdash-plugin/native`, not `./plugin`.
  Rationale: `src/plugin.ts` is still the sandboxed plugin that must keep working until T002/T009. T009 renames the entry when it reshapes the exports.
  Date/Author: 2026-10-27 / implement-executor

## Surprises & Discoveries

- Observation: `ctx.cron.schedule()` is an upsert that resets `next_run_at` to the next match every time it is called. A route that called it on every request kept postponing the task, so the once-a-minute Cloudflare dev bridge never found it due. T002's reconcile ("on every task run and on save") must schedule only a task that is missing or whose schedule changed.
  Evidence: `emdash/src/plugins/cron.ts` `ON CONFLICT ... next_run_at = ${nextRun}`. On Cloudflare dev, with `spike-cron` polled every 5 s, `lastRunAt` stayed null across 5 bridge POSTs. After the route stopped rescheduling, the task fired at 08:53:40.
- Observation: cron fires differently on each host. Node uses the in-process `NodeCronScheduler` timer, which fires on the minute. Cloudflare `astro dev` uses the dev scheduler bridge, which POSTs `/_emdash/api/dev/scheduled-tasks` every 60 s from server start, so a task runs up to about 60 s late. A Cloudflare build uses the Worker's `scheduled()` handler. Under `wrangler dev --test-scheduled` that handler is triggered with `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=<name>`, because `/__scheduled` returns 404 in this Wrangler version. An overdue task runs once on restart, not once per missed tick.
  Evidence: results/2026-10-27/native-plugin.md "Cron"; native-*-cron-log.txt.
- Observation: EmDash refuses `localtest.me`, `lvh.me`, `nip.io`, `sslip.io`, `xip.io` and `traefik.me` by name before any DNS lookup. To exercise the DNS-aware check, use a name like `localhost.direct`.
  Evidence: `emdash/src/security/ssrf.ts` `BLOCKED_HOSTNAME_SUFFIXES`. `localhost.direct` → `Hostname resolves to a non-public IP address` on both hosts.
- Observation: in `bun test`, `mock.module('emdash', ...)` in packages/emdash-ui replaced `emdash` for every test file loaded after it. A bare stub made `import { createUnrestrictedHttpAccess } from 'emdash'` fail to link. Native host tests in T002+ will hit the same problem with any partial `emdash` stub.
  Evidence: `SyntaxError: Export named 'createUnrestrictedHttpAccess' not found in module .../emdash/dist/index.mjs` in the full suite only. The test passes once the stub spreads the real module.
- Observation: the first `astro dev` start in `native-cf` mode after the config change re-optimized dependencies, reloaded, and then hung every request. The next start on the same port also hung. Every later start on other ports worked with the same plugin code. A bisect that removed the plugin imports did not reproduce the hang.
  Evidence: /tmp/sb-native-cf.log (`optimized dependencies changed. reloading`), curl timeouts on :4431, then `root 200` on :4432–:4436.
