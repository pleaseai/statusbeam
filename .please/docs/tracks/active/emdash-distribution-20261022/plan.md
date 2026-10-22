# Plan: EmDash distribution: sandboxed engine plugin + Astro render library

> Track: emdash-distribution-20261022
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: emdash-distribution-20261022
- **Issue**: (assigned at publish)
- **Created**: 2026-10-22
- **Approach**: Move the engine's remaining pure logic from `apps/worker` and `apps/web` into `@statusbeam/core`. Then build two thin adapters on it: a sandboxed EmDash plugin (`@statusbeam/emdash-plugin`) and an Astro source library (`@statusbeam/emdash-ui`). A spike against a real EmDash demo site gates the plugin work.
- **Plan Depth**: deep
- **Planned At**: 12da16f

## Context

### Problem

ADR-0004 adds an EmDash channel. That needs proof that sandbox probe semantics hold, one wire contract for both producers, and an engine adapter for EmDash storage, routes and admin, without forking core.

### Constraints

- Several pieces of engine logic still live in the apps (exploration):
  - the rollup, change detection and poll selection (`apps/worker/src/ingest.ts:48-168`, `index.ts:36-48`);
  - notification delivery (`notify.ts`);
  - webhook auth and grading (`webhook.ts:19-67`);
  - the public response shapes (`apps/web/src/pages/api/*`), which have no schema anywhere.
- The aggregate response nests `uptime`, while the per-site response is a flat `SiteSummary`. The contract codifies both as they are.
- `checkHttp` turns every fetch throw into `down`, so FR-13 needs one additive core change.
- EmDash constraints:
  - public routes need `response: "raw"`, whose header allowlist drops `Access-Control-Allow-Origin`;
  - Block Kit has no hidden field and allows one submit per form;
  - `admin.portableTextBlocks` is native-only;
  - test hosts reproduce no CPU or subrequest limits.
- No `emdash` dependency exists yet. The apps/web components are React + Tailwind, so the library rewrites them in Astro.

### Non-Goals

Considered and not built (beyond the spec's Out of Scope):
- **Caching the parsed config between runs.** FR-20 asks for re-validation every run. Revisit only if T001 finds the parse breaks the CPU budget.
- **Cross-origin browser access to plugin endpoints.** The library fetches server-side; T012 documents the gap.
- **Normalizing the two uptime shapes.** It would break the standalone API for no consumer need.

### STOP Conditions

- The spike finds that a mode grades differently from the ADR-0004 probe contract, or that the 5-minute cadence or capacity is unworkable. Stop after T001 and revise ADR-0004 with the user before any Phase 3 task (AC-004).
- An EmDash API this plan relies on behaves differently from the skill docs: `response: "raw"`, `compareAndSet` on settings, secret settings, or `admin.portableTextBlocks` on a native plugin. Stop and report instead of building a workaround.

## Architecture Decision

**Core becomes the single engine; apps and plugin are I/O adapters.** Logic both producers need moves to core as pure functions that take `now`. Standalone switches over in the same task, with its tests unchanged (the NFR-5 proof). Rejected: copies inside the plugin, which would turn FR-9/NFR-3 parity into a test of copy fidelity.

**Contract lives in core** as `statusResponseSchema` and `siteResponseSchema`, plus builders and a route-path map with a `standalone` and an `emdash` flavor. It is exported through a `@statusbeam/core/contract` subpath that keeps `yaml` out of the library. The version is an in-body `version: 1` (FR-6) (raw routes strip custom headers).

**Plugin storage.** History is kept as per-day count buckets `{up, degraded, down, total}` per `(slug, date)` in `ctx.storage`, pruned past 90 days, and the snapshot lives in `ctx.kv`. Raw checks would be about 26k rows per monitor over 90 days, too many to query under 50 ms of CPU. Standalone's D1 `GROUP BY` and the plugin buckets feed the same core rollup.

**Limit outcomes.** Core's `CheckResult` gains an optional `limit` field, set when the injected fetch throws an error with a limit marker (body / subrequests / cpu). `CheckStatus` stays closed. The plugin maps body limits to unsupported and subrequest or CPU limits to skipped. The marker's form follows how T001 finds each runner reports a limit.

**Config.** The YAML is one plain setting written with `compareAndSet`. The loaded revision sits in `ctx.kv` per user (no hidden field in Block Kit). The four secrets are `secret` settings fields, and generic-webhook URLs go one per line. Plugin-only rules run after `configSchema.safeParse`, which keeps plugin policy out of core.

**Render library ships `.astro` source** (ADR-0002 precedent), with scoped CSS custom properties and fallbacks instead of Tailwind. The Portable Text block is a separate native entry point (`./block` descriptor, `./astro` `blockComponents`), so sites that only render never register a plugin.

**Spike harness:** a private `apps/emdash-demo` EmDash site, reused for manual checks and as the docs' reference install.

## Tasks

**Phase 1 — spike**

- [ ] T001 [SPIKE] Run the probe-semantics spike in all three execution modes and record the results in ADR-0004 (file: docs/adr/0004-emdash-plugin-distribution.md)
  Validation: ADR-0004 gains a results table per mode covering: the >8 MiB, slow-body and streaming fixtures (AC-001, AC-002); whether a body, subrequest or CPU-limit rejection is distinguishable from a network error and how it surfaces (FR-2); probes finished per run past the subrequest cap, including notification deliveries and config re-validation (AC-003, FR-3); and the cron minimum interval (FR-4). It ends in either Accepted or a revision of the affected decisions and spec phases (AC-004, FR-5). The harness (`apps/emdash-demo` plus fixtures) is committed with a README that reproduces each run.
  Method: manual runs on Worker Loader, the Node/workerd runner and in-process (`plugins: []`), recorded in the ADR.
  STOP: a mode contradicts the probe contract, the cadence or capacity is unworkable, or a runner is unavailable on the account. Report to the user before marking the ADR.

**Phase 2 — shared contract and core extraction**

- [ ] T002 Define the public status contract in core and serve the standalone endpoints from it (file: packages/core/src/contract.ts)
  Validation: the standalone `/api/status.json`, `/api/status/<slug>.json` and badge responses parse under the exported schemas. They are byte-identical to today apart from the added `version` field. The path map yields both the standalone and the plugin URL for every endpoint. `@statusbeam/core/contract` imports without `yaml`.
  Method: `bun test packages/core` plus a `bun run build` check of the subpath export
- [ ] T003 Move the rollup, change detection, poll selection, notification delivery, webhook helpers and config issue list from the apps into core, with standalone switched over (file: packages/core/src/rollup.ts)
  Validation: the existing worker and web tests pass unchanged. A configuration with a YAML syntax error and one with schema errors both produce a path-annotated issue list. Rollup output for a fixed check history and `now` equals the current worker output, with no core logic duplicated in the apps (NFR-5).
  Method: `bun test` (repo root), plus a new core rollup test against a recorded worker fixture

**Phase 3 — engine plugin**

- [ ] T004 Scaffold the sandboxed engine plugin and run scheduled checks into day buckets and a snapshot (file: packages/emdash-plugin/src/plugin.ts) (depends on T001, T003)
  Validation: a cron run checks every configured monitor through `ctx.http.fetch`, updates the per-day buckets and snapshot, and prunes buckets older than 90 days. 90-day per-day uptime from the buckets equals the standalone rollup for the same check history (FR-8, FR-9). Webhook-only Sentry monitors are not polled. Runs beyond the per-run capacity follow T001's decision (split or cap), so no run exceeds the runner limits (NFR-2).
  Method: `bun test packages/emdash-plugin` with `createPluginTestHost` and `host.http.respond`
- [ ] T005 Send status-change notifications and grade runtime-limit failures as unsupported or skipped (file: packages/emdash-plugin/src/run.ts) (depends on T004)
  Validation: A status change posts to the Slack and generic-webhook URLs held in secret settings fields this task declares (FR-10), and delivery logs never contain a full URL. A body-limit failure marks the probe unsupported (AC-009); a subrequest- or CPU-limit failure marks it skipped (AC-010). Neither notifies (AC-011) nor changes status or uptime (AC-012), and the monitor shows a persistent warning naming the limit. A GET monitor is never retried as HEAD (AC-013). Standalone results are unaffected by the new core `limit` field.
  Method: `bun test packages/emdash-plugin packages/core`
- [ ] T006 Serve the public status and badge endpoints as raw routes with HTTP-level parity against standalone (file: packages/emdash-plugin/src/routes/public.ts) (depends on T002, T004)
  Validation: The plugin status endpoint returns an unwrapped body the contract accepts (AC-005). The badge endpoints return valid shields.io bodies (AC-006). For the same snapshot, every plugin endpoint's response body equals the standalone endpoint's, with `generatedAt` normalized (NFR-3). Successful GETs carry the route's `cacheControl`. An unknown slug returns the standalone 404 body. An invalid `period` falls back to `month` as standalone does.
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost`, invoking the `apps/web` route handlers with their data layer mocked to the same snapshot (`mock.module`)
- [ ] T007 Accept Statuspage and Sentry webhooks on public routes that fail closed (file: packages/emdash-plugin/src/routes/webhooks.ts) (depends on T004)
  Validation: With no secret set, every request is rejected (AC-007). A mismatched token is rejected before any grading or storage access, with no status change (AC-008). A valid token with an unknown slug or a check kind that does not match the provider returns 404 and changes nothing. A valid event updates the snapshot and today's bucket like a polled result, and an event arriving during a cron run loses no bucket counts. Non-POST requests get 405.
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost`

**Phase 4 — monitor configuration**

- [ ] T008 Validate the YAML with plugin-only rules, keep secrets in encrypted settings, and gate each scheduled run on re-validation (file: packages/emdash-plugin/src/config.ts) (depends on T004)
  Validation: The YAML is validated by the core schema (FR-14). `delivery: queue` is an error (AC-018). TCP/SSL monitors warn (AC-019). A Sentry poll with no token warns (AC-020). Too many monitors for one run warns (AC-021). A Slack or webhook URL in the YAML is an error pointing to the encrypted settings (AC-022). Duplicate slugs are an error. A generic-webhook secret line that is not a URL is reported, not dropped. A run whose stored config fails validation checks nothing and changes no status (AC-023), and records an error that stays until a valid save (AC-024).
  Method: `bun test packages/emdash-plugin`
- [ ] T009 Build the administrator-only Block Kit config page and the status dashboard widget (file: packages/emdash-plugin/src/admin.ts) (depends on T008)
  Validation: Saving an invalid config shows every issue with its path (AC-014) and keeps the stored one (AC-015). A save after someone else's save is refused with a reload message (AC-016). A non-administrator is refused on every page action (AC-017). Validate checks without saving (FR-16). Test site shows graded status and latency (AC-025) and writes no history or status (AC-026). The run-time error from T008 shows as a banner. A YAML too large for a Block Kit string is refused with a message, not truncated. The widget shows overall status and per-severity counts (FR-12).
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost` admin interactions, plus a manual pass in `apps/emdash-demo`
  STOP: Block Kit cannot carry unsaved YAML to a Validate action separate from Save. Report the options before changing the FR-16 interaction.

**Phase 5 — render library and docs**

- [ ] T010 Build the Astro status components and contract client in `@statusbeam/emdash-ui` (file: packages/emdash-ui/src/components/StatusBanner.astro) (depends on T002)
  Validation: Banner, 90-day bars and per-site detail render from either a standalone or a plugin base URL. Against a standalone deployment they show the same per-site status as its page (AC-027). Every status is conveyed by a text label or icon as well as color (NFR-4). A response that fails the contract renders an unavailable state instead of throwing. The package has no scheduled work, storage or engine imports (NFR-1).
  Method: `bun test packages/emdash-ui` for the contract client (bun cannot import `.astro`), plus `Skill("please:test-browser")` on an `apps/emdash-demo` page pointed at standalone and at the plugin
- [ ] T011 Add the opt-in native "status" Portable Text block entry point (file: packages/emdash-ui/src/block.ts) (depends on T010)
  Validation: registering the `./block` descriptor in `apps/emdash-demo` adds a "status" block to the post editor. A post embedding it renders with the T010 components. A site that imports only the components registers no plugin (FR-22).
  Method: manual check in `apps/emdash-demo` via `Skill("please:test-browser")`
- [ ] T012 Document installation and operation, and register both packages for release (file: apps/docs/src/content/docs/emdash.md) (depends on T006, T007, T009, T011)
  Validation: The guide states that a sandbox runner is required (AC-028). It states that in-process mode is a trust decision giving up isolation and limits (AC-029), and which deployment shape keeps checks and page independent of a CMS outage (AC-030). It also covers the unrestricted network capability, the probe-contract limits and the missing cross-origin header. Both packages appear in the release-please config and manifest, and in the `publish.yml` tag map, with CHANGELOGs.
  Method: docs build (`bunx turbo run build --filter=@statusbeam/docs`) plus a review of the release-please dry-run output

## Key Files

- Create:
  - `packages/core/src/contract.ts`, `packages/core/src/rollup.ts`
  - `packages/emdash-plugin/` (`emdash-plugin.jsonc`, `src/plugin.ts`, `src/run.ts`, `src/config.ts`, `src/admin.ts`, `src/routes/*`)
  - `packages/emdash-ui/` (`src/components/*.astro`, `src/client.ts`, `src/block.ts`)
  - `apps/emdash-demo/`, `apps/docs/src/content/docs/emdash.md`
- Modify:
  - `packages/core/src/{check.ts,types.ts,index.ts}`, `packages/core/package.json` (subpath export)
  - `apps/worker/src/{ingest.ts,index.ts,notify.ts,webhook.ts}`, `apps/web/src/pages/api/**`
  - `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/publish.yml`, `.please/docs/knowledge/tech-stack.md`
- Reuse:
  - `checkSite`, `configSchema`, the badge builders, `overallSeverity`, `windowUptime`, `formatUptime`, `getDict`
  - the severity tokens in `apps/web/src/styles/global.css:81-86`

## Verification

- [ ] `bun run lint`, `bun run typecheck`, `bun run build` and `bun test` are green after every task, with the standalone tests unmodified through T002–T003.
- [ ] The ADR-0004 spike results (T001) are reviewed with the user before T004 starts.
- [ ] `apps/emdash-demo` runs the full install: the engine through a sandbox runner, the components on a page, and the block in a post.

## Review Focus

- Duplicate `slug` values in the YAML collide in bucket keys. T008 rejects them.
- YAML larger than Block Kit's 64 KiB string limit. T009 refuses it with a message instead of truncating.
- A webhook with a valid token but an unknown slug or the wrong check kind. T007 returns 404 and changes nothing.
- An invalid or missing badge `period` query. T006 falls back to `month` like standalone.
- Generic-webhook URL secret lines that are blank or not URLs. T008 reports them.

## Progress

## Decision Log

- 2026-10-22: Architecture follows ADR-0004 as amended in #99. No competing architect pass, because the spec leaves no strategy open.
- 2026-10-22: Plan review (deep, 6 lenses) applied 6 fixes: notification secret fields owned by T005, URL-free delivery logs, webhook/cron bucket race, webhook rejection order under host-parsed input, a runnable parity method, and component checks via the demo site.
- 2026-10-22: The plan has 12 tasks covering two packages. The single-track ruling was made at spec review (the user kept one track), so the Phase 4 scope prompt was not repeated.

## Surprises & Discoveries
