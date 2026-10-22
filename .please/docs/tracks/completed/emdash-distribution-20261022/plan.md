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

**Limit outcomes.** Core's `CheckResult` gains an optional `limit` field, set to `body` when the injected fetch throws an error whose message contains the host's body-limit text (T001: limit errors are plain `Error`s, told apart only by message). `CheckStatus` stays closed, and the plugin maps `limit: body` to unsupported. Subrequest, CPU and wall-time limits are not recorded as outcomes: CPU and wall kills never reach the plugin, so each run is sharded across cron tasks of about 6 monitors, each task budgets its calls (probes, notifications, kv/storage, log) before it starts, and a killed task writes nothing. Each probe has a 10 s plugin-side deadline graded `down` with code 0, so one hung target cannot stall the task.

**Config.** The YAML is one plain setting written with `compareAndSet`. The loaded revision sits in `ctx.kv` per user (no hidden field in Block Kit). The four secrets are `secret` settings fields, and generic-webhook URLs go one per line. Plugin-only rules run after `configSchema.safeParse`, which keeps plugin policy out of core.

**Render library ships `.astro` source** (ADR-0002 precedent), with scoped CSS custom properties and fallbacks instead of Tailwind. The Portable Text block is a separate native entry point (`./block` descriptor, `./astro` `blockComponents`), so sites that only render never register a plugin.

**Spike harness:** a private `apps/emdash-demo` EmDash site, reused for manual checks and as the docs' reference install.

## Tasks

**Phase 1 — spike**

- [x] T001 [SPIKE] Run the probe-semantics spike in all three execution modes and record the results in ADR-0004 (file: docs/adr/0004-emdash-plugin-distribution.md) [FR-1, FR-2, FR-3, FR-4, FR-5, AC-001, AC-002, AC-003, AC-004]
  Validation: ADR-0004 gains a results table per mode covering: the >8 MiB, slow-body and streaming fixtures (AC-001, AC-002); whether a body, subrequest or CPU-limit rejection is distinguishable from a network error and how it surfaces (FR-2); probes finished per run past the subrequest cap, including notification deliveries and config re-validation (AC-003, FR-3); and the cron minimum interval (FR-4). It ends in either Accepted or a revision of the affected decisions and spec phases (AC-004, FR-5). The harness (`apps/emdash-demo` plus fixtures) is committed with a README that reproduces each run.
  Method: manual runs on Worker Loader, the Node/workerd runner and in-process (`plugins: []`), recorded in the ADR.
  STOP: a mode contradicts the probe contract, the cadence or capacity is unworkable, or a runner is unavailable on the account. Report to the user before marking the ADR.

**Phase 2 — shared contract and core extraction**

- [x] T002 Define the public status contract in core and serve the standalone endpoints from it (file: packages/core/src/contract.ts) [FR-6]
  Validation: the standalone `/api/status.json`, `/api/status/<slug>.json` and badge responses parse under the exported schemas. They are byte-identical to today apart from the added `version` field. The path map yields both the standalone and the plugin URL for every endpoint. `@statusbeam/core/contract` imports without `yaml`.
  Method: `bun test packages/core` plus a `bun run build` check of the subpath export
- [x] T003 Move the rollup, change detection, poll selection, notification delivery, webhook helpers and config issue list from the apps into core, with standalone switched over (file: packages/core/src/rollup.ts) [NFR-5]
  Validation: the existing worker and web tests pass unchanged. A configuration with a YAML syntax error and one with schema errors both produce a path-annotated issue list. Rollup output for a fixed check history and `now` equals the current worker output, with no core logic duplicated in the apps (NFR-5).
  Method: `bun test` (repo root), plus a new core rollup test against a recorded worker fixture

**Phase 3 — engine plugin**

- [x] T004 Scaffold the sandboxed engine plugin and run sharded scheduled checks into day buckets and a snapshot (file: packages/emdash-plugin/src/plugin.ts) (depends on T001, T003) [FR-8, FR-9, NFR-2, AC-031]
  Validation: a cron run checks every configured monitor through `ctx.http.fetch`, updates the per-day buckets and snapshot, and prunes buckets older than 90 days. 90-day per-day uptime from the buckets equals the standalone rollup for the same check history (FR-8, FR-9). Webhook-only Sentry monitors are not polled. Each run is sharded across cron tasks of at most the per-task monitor count T001 measured, every monitor is covered once per cadence, and no task exceeds the runner limits (NFR-2). A target that has not finished within 10 s is graded `down` and the task moves on to its remaining monitors (AC-031).
  Method: `bun test packages/emdash-plugin` with `createPluginTestHost` and `host.http.respond`
- [x] T005 Send status-change notifications, mark body-limit failures unsupported, and budget each task's calls up front (file: packages/emdash-plugin/src/run.ts) (depends on T004) [FR-10, FR-13, AC-009, AC-010, AC-011, AC-012, AC-013]
  Validation: A status change posts to the Slack and generic-webhook URLs held in secret settings fields this task declares (FR-10), and delivery logs never contain a full URL. A body-limit failure, recognised by the host's message text, marks the probe unsupported (AC-009), sends no notification (AC-011), changes no status or uptime (AC-012), and the monitor shows a persistent warning naming the limit. Each task's planned calls (probes, notification deliveries, kv/storage, log) fit its budget before it starts (AC-010), and a task the runtime ends early leaves every monitor unchanged (AC-012). A GET monitor is never retried as HEAD (AC-013). Standalone results are unaffected by the new core `limit` field.
  Method: `bun test packages/emdash-plugin packages/core`
- [x] T006 Serve the public status and badge endpoints as raw routes with HTTP-level parity against standalone (file: packages/emdash-plugin/src/routes/public.ts) (depends on T002, T004) [FR-7, NFR-3, AC-005, AC-006]
  Validation: The plugin status endpoint returns an unwrapped body the contract accepts (AC-005). The badge endpoints return valid shields.io bodies (AC-006). For the same snapshot, every plugin endpoint's response body equals the standalone endpoint's, with `generatedAt` normalized (NFR-3). Successful GETs carry the route's `cacheControl`. An unknown slug returns the standalone 404 body. An invalid `period` falls back to `month` as standalone does.
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost`, invoking the `apps/web` route handlers with their data layer mocked to the same snapshot (`mock.module`)
- [x] T007 Accept Statuspage and Sentry webhooks on public routes that fail closed (file: packages/emdash-plugin/src/routes/webhooks.ts) (depends on T004) [FR-11, AC-007, AC-008]
  Validation: With no secret set, every request is rejected (AC-007). A mismatched token is rejected before any grading or storage access, with no status change (AC-008). A valid token with an unknown slug or a check kind that does not match the provider returns 404 and changes nothing. A valid event updates the snapshot and today's bucket like a polled result, and an event arriving during a cron run loses no bucket counts. Non-POST requests get 405.
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost`

**Phase 4 — monitor configuration**

- [x] T008 Validate the YAML with plugin-only rules, keep secrets in encrypted settings, and gate each scheduled run on re-validation (file: packages/emdash-plugin/src/config.ts) (depends on T004) [FR-14, FR-18, FR-19, FR-20, AC-018, AC-019, AC-020, AC-021, AC-022, AC-023, AC-024]
  Validation: The YAML is validated by the core schema (FR-14). `delivery: queue` is an error (AC-018). TCP/SSL monitors warn (AC-019). A Sentry poll with no token warns (AC-020). More monitors than one run's sharded tasks can probe warns (AC-021). A Slack or webhook URL in the YAML is an error pointing to the encrypted settings (AC-022). Duplicate slugs are an error. A generic-webhook secret line that is not a URL is reported, not dropped. A run whose stored config fails validation checks nothing and changes no status (AC-023), and records an error that stays until a valid save (AC-024).
  Method: `bun test packages/emdash-plugin`
- [x] T009 Build the administrator-only Block Kit config page and the status dashboard widget (file: packages/emdash-plugin/src/admin.ts) (depends on T008) [FR-12, FR-15, FR-16, FR-17, AC-014, AC-015, AC-016, AC-017, AC-025, AC-026]
  Validation: Saving an invalid config shows every issue with its path (AC-014) and keeps the stored one (AC-015). A save after someone else's save is refused with a reload message (AC-016). A non-administrator is refused on every page action (AC-017). Validate checks without saving (FR-16). Test site shows graded status and latency (AC-025) and writes no history or status (AC-026). The run-time error from T008 shows as a banner. A YAML too large for a Block Kit string is refused with a message, not truncated. The widget shows overall status and per-severity counts (FR-12).
  Method: `bun test packages/emdash-plugin` with `createPluginRuntimeTestHost` admin interactions, plus a manual pass in `apps/emdash-demo`
  STOP: Block Kit cannot carry unsaved YAML to a Validate action separate from Save. Report the options before changing the FR-16 interaction.

**Phase 5 — render library and docs**

- [x] T010 Build the Astro status components and contract client in `@statusbeam/emdash-ui` (file: packages/emdash-ui/src/components/StatusBanner.astro) (depends on T002) [FR-21, NFR-1, NFR-4, AC-027]
  Validation: Banner, 90-day bars and per-site detail render from either a standalone or a plugin base URL. Against a standalone deployment they show the same per-site status as its page (AC-027). Every status is conveyed by a text label or icon as well as color (NFR-4). A response that fails the contract renders an unavailable state instead of throwing. The package has no scheduled work, storage or engine imports (NFR-1).
  Method: `bun test packages/emdash-ui` for the contract client (bun cannot import `.astro`), plus `Skill("please:test-browser")` on an `apps/emdash-demo` page pointed at standalone and at the plugin
- [x] T011 Add the opt-in native "status" Portable Text block entry point (file: packages/emdash-ui/src/block.ts) (depends on T010) [FR-22]
  Validation: registering the `./block` descriptor in `apps/emdash-demo` adds a "status" block to the post editor. A post embedding it renders with the T010 components. A site that imports only the components registers no plugin (FR-22).
  Method: manual check in `apps/emdash-demo` via `Skill("please:test-browser")`
- [x] T012 Document installation and operation, and register both packages for release (file: apps/docs/src/content/docs/emdash.md) (depends on T006, T007, T009, T011) [FR-23, AC-028, AC-029, AC-030]
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

- [x] `bun run lint`, `bun run typecheck`, `bun run build` and `bun test` are green after every task, with the standalone tests unmodified through T002–T003.
- [x] The ADR-0004 spike results (T001) are reviewed with the user before T004 starts.
- [ ] `apps/emdash-demo` runs the full install: the engine through a sandbox runner, the components on a page, and the block in a post.

## Review Focus

- Duplicate `slug` values in the YAML collide in bucket keys. T008 rejects them.
- YAML larger than Block Kit's 64 KiB string limit. T009 refuses it with a message instead of truncating.
- A webhook with a valid token but an unknown slug or the wrong check kind. T007 returns 404 and changes nothing.
- An invalid or missing badge `period` query. T006 falls back to `month` like standalone.
- Generic-webhook URL secret lines that are blank or not URLs. T008 reports them.

## Progress

- [x] (2026-10-22 18:40 KST) T001 Run the probe-semantics spike in all three execution modes and record the results in ADR-0004 — `fbbf425`, `29f7dc6`, ADR accepted in this commit
  Evidence: `apps/emdash-demo/results/2026-10-22/` holds the per-mode runs; ADR-0004 "Spike results (2026-10-22)" records buffering and the 8 MiB limit in all modes, the 30 s invocation kill (in-process blocks), message-only limit errors, the 10-call Worker Loader bridge budget (~6 monitors per invocation), per-task budgets for separate cron tasks, and a 1-minute cron floor. Status set to Accepted after the user chose a 10 s deadline graded down, up-front budgeting, and sharding.
- [x] (2026-10-22 16:20 KST) T002 Define the public status contract in core and serve the standalone endpoints from it — `9bb4c21`
  Evidence: `bun test` → 324 pass, 0 fail; `contract.test.ts` asserts each body equals the legacy payload with only `version: 1` prepended, parses under its schema, and the path map yields both flavors; `grep -c yaml packages/core/dist/contract.js` → 0; `bun run build`/`typecheck`/`lint` green in the track tree.
- [x] (2026-10-22 16:24 KST) T003 Move the rollup, change detection, poll selection, notification delivery, webhook helpers and config issue list into core — `16c71b5`
  Evidence: `bun test` → 352 pass, 0 fail (314 before); no existing `*.test.ts` modified (`git diff --name-status 12da16f..HEAD -- '*.test.ts'` shows only additions); `rollup.test.ts` reproduces the pre-refactor worker output recorded in `fixtures/rollup-worker.json`; `config-issues.test.ts` covers syntax and schema issue paths; build/typecheck/lint green.
- [x] (2026-10-22 17:34 KST, live check 20:45 KST) T010 Build the Astro status components and contract client in `@statusbeam/emdash-ui` — `ecd101a`, `98501b9`, `a378a12`
  Evidence: `bun test` → 361 pass, 0 fail (`packages/emdash-ui` 9 pass: URL building for both flavors, valid body, schema-failing/non-JSON/503/rejected fetch → unavailable, and an import scan that allows only `@statusbeam/core/contract`); build 6/6, typecheck 10/10 (`astro check` 0 errors), lint clean in the track tree; `grep -c yaml packages/core/dist/contract.js` → 0. Browser check on `apps/emdash-demo` `/status` against a local fixture built by core's `buildStatusResponse`/`buildSiteResponse`: icon plus label for every severity, and "Status unavailable" for an enveloped body and for the not-yet-existing plugin route. Live check (AC-027): the demo `/status` page fed the live `https://demo.statusbeam.dev` bodies through a local proxy that adds only `version: 1` renders the same banner (Major System Outage) and per-site status and uptime as the live page (GitHub API 0.00% Major Outage; Cloudflare 99.85%, npm Registry 100%, Cloudflare DNS 100% Operational). The deployed standalone predates the versioned contract, so the components read it directly only after it is redeployed with this track. Plugin base URL: T006 proves the plugin bodies are byte-equal to standalone's, so the same rendering applies; the demo's `?source=plugin` path was exercised only as far as the unavailable state. The demo default URL was corrected to `demo.statusbeam.dev` (`6ebb1ff`).
- [x] (2026-10-22 17:38 KST) T004 Scaffold the sandboxed engine plugin and run sharded scheduled checks into day buckets and a snapshot — `09f9947`
  Evidence: `bun test` → 376 pass, 0 fail; `bun run test:host` (vitest in workerd with `createPluginRuntimeTestHost`) → 8 pass; build 7/7, typecheck 11/11, lint clean in the track tree. Host tests: `check-0` of 8 monitors probes the first 6 by slug and writes 6 buckets plus `snapshot:0`; `check-0`+`check-1` cover all 8 once; webhook-only Sentry is not polled; the daily `maintenance` task prunes buckets past 90 days; `plugin:activate` schedules `check-0..2` + `maintenance` for 14 monitors and cancels surplus shards when the config shrinks. Bun tests: bucket-fed rollup equals `fixtures/rollup-worker.json`'s expected summary; shard counts `[0,1,1,2,2,3,8,8,8]` for n=`[0,1,6,7,12,13,48,49,500]` with every monitor in exactly one shard; a full shard makes exactly 10 counted calls and 0 log calls; a never-resolving fetch is graded `down` code 0 after the deadline while its neighbours are still probed (AC-031).
- [x] (2026-10-22 18:05 KST) T011 Add the opt-in native "status" Portable Text block entry point — `4756038`
  Evidence: `bun test` → 385 pass, 0 fail; build 7/7, typecheck 11/11, lint clean in the track tree. `entry-graph.test.ts`: the `.` and `./client` import closures never reach `block.ts`, `plugin.ts`, `astro/` or `emdash` (fails under a mutation that re-exports `./block` from the client); the plugin has only `id`, `version`, `admin.portableTextBlocks`. Demo (`STATUSBEAM_BLOCK=1`, Node in-process dev, local fixture): `/_emdash/api/manifest` lists `statusbeam-status-block` with block type `statusbeam-status`; the editor slash menu offers "Status" and its insert form shows View, Site slug, Status source URL, Source type; `/posts/status-demo` renders the banner and the API site detail. Without the flag the manifest has no `statusbeam-status-block` and `/status` still renders (FR-22).
- [x] (2026-10-22 18:20 KST) T005 Send status-change notifications, mark body-limit failures unsupported, and budget each task's calls up front — `ae32fe7`, `7a24cf7`
  Evidence: `bun test` → 404 pass, 0 fail; `bun run test:host` → 9 pass (a secret set through the runtime host is read back by `settings.list` and a Slack message is posted); build 7/7, typecheck 11/11, lint clean in the track tree; `bun test apps/worker` unchanged at 49 pass. The classifier matches the spike's exact `Plugin HTTP response body exceeds the 8388608 byte limit` text (and the Node/workerd wrapped form) and not DNS or deadline errors; core sets `limit: 'body'` only when a classifier is injected (AC-009). A limit run increments no bucket, keeps the last result and history, sends nothing, and records `{limit:'body', since, lastSeen}` until a normal probe clears it (AC-011, AC-012). One coalesced POST per destination carries every change of the run; stored delivery outcomes hold only kind plus redacted host (FR-10). Planned calls (computed before the first probe) bound actual calls at ≤ 10 for 0/1/2 destinations; too many destinations probe nothing and record `capacityError` (AC-010). A run failing at `storage.getMany`, `kv.list` or `storage.putMany` leaves buckets and kv byte-identical, and the next run re-sends (AC-012). A body-limit GET monitor issues exactly one `GET` (AC-013). Capacity: 5/4/3 probes per task for 0/1/2 destinations, 40/32/24 monitors per cadence.
- [x] (2026-10-22 18:45 KST) T006 Serve the public status and badge endpoints as raw routes with HTTP-level parity against standalone — `bf331d1`
  Evidence: `bun test` → 407 pass, 0 fail; `bun run test:host` → 17 pass; build 7/7, typecheck 11/11, lint clean in the track tree. Routes under `/_emdash/api/plugins/statusbeam`: `status` (aggregate, or per-site with `?slug=`), `badge`, `badge-uptime`, `badge-response-time`, all `public`, `response: "raw"`, GET only. Host tests (workerd, real `apps/web/src/pages/api/**` handlers with `lib/data` mocked to the same `summariesFromSnapshot` output): bodies parse under the contract schemas with no envelope (AC-005); all four badge routes parse under `shieldsEndpointSchema` (AC-006); aggregate, per-site and every badge body is byte-equal to standalone with only `generatedAt` replaced, status codes included (NFR-3); `cache-control` equals standalone's `public, s-maxage=60, stale-while-revalidate=600` on success and is absent from 404s; unknown slugs give the standalone 404 body; invalid or missing `period` equals `month`; no or invalid config equals standalone's empty-summary bodies. `public.test.ts`: at most 2 bridge calls (`settings.list`, `kv.list`) per route for 200 monitors, 1 with no config.
- [x] (2026-10-22 19:05 KST) T008 Validate the YAML with plugin-only rules, keep secrets in encrypted settings, and gate each scheduled run on re-validation — `7fcf8a8`
  Evidence: `bun test` → 421 pass, 0 fail; `bun run test:host` → 17 pass; build 7/7, typecheck 11/11, lint clean in the track tree. `tests/config.test.ts` (`validatePluginConfig`): core schema issues keep their paths, e.g. `sites[0].url` (FR-14); `delivery: queue` is an error at `notifications.delivery` (AC-018); TCP/SSL warn at `sites[n].check` "over HTTP" (AC-019); a Sentry poll without `sentryToken` warns at `sites[0].sentry` (AC-020); 45 monitors warn "probes 40", "5 would go unchecked", and destinations leaving 0 probes per task are a `capacity` error (AC-021); YAML Slack/webhook URLs are errors naming `slackWebhookUrl`/`webhookUrls` without echoing the URL (AC-022); duplicate slugs error at `sites[1].slug`; invalid secret lines warn with their line number. An invalid stored config makes exactly `settings.list` + `kv.set`, leaves buckets, snapshots and cron tasks identical, and records `snapshot:config-error` (AC-023); the record survives later invalid runs, reconcile and maintenance, and a valid run or `reconcileShards(ctx, { clearConfigError: true })` clears it within budget (AC-024).
- [x] (2026-10-22 19:30 KST) T007 Accept Statuspage and Sentry webhooks on public routes that fail closed — `3d439a7`, follow-up `f6ffaeb`
  Evidence: `bun test` → 433 pass, 0 fail; `bun run test:host` → 21 pass; build 7/7, typecheck 11/11, lint clean in the track tree. Routes `webhooks/statuspage` and `webhooks/sentry` (`POST …/_emdash/api/plugins/statusbeam/webhooks/{provider}?slug=&token=`, raw text body so nothing is parsed before auth). No `webhookSecret` → 401 for every request after only `settings.list` (AC-007); wrong, truncated, extended, empty or absent tokens → 401 with only `settings.list` and byte-identical storage, even for a non-JSON body (AC-008); unknown slug, missing slug or provider/check-kind mismatch → 404 with nothing written; GET/PUT/DELETE/HEAD/PATCH → 405 with no bridge calls. A valid event writes the webhook-owned row `slug:date:webhook` and key `snapshot:webhook:{slug}`, and summaries reflect it, including webhook-only Sentry monitors. Race test: a webhook fired between a shard's reads and writes keeps both writers' counts (merged day total 2, later 3) and the newest result wins. A webhook change makes 5 + D calls (≤ 10); more destinations than fit records the change with `deliverySkipped: 'capacity'`. Follow-up `f6ffaeb`: Sentry poll monitors now receive the `sentryToken` secret (poll selection, shard sizing and the check), proven by a test that fails without the wiring.
- [x] (2026-10-22 20:00 KST) T009 Build the administrator-only Block Kit config page and the status dashboard widget — `41fb606`
  Evidence: `bun test` → 466 pass, 0 fail; `bun run test:host` → 26 pass; build 7/7, typecheck 11/11, lint clean in the track tree; every response passes `validateBlockResponse`. Invalid save shows each issue with its path (`sites[0].url`, `sites[1].slug`, `notifications.delivery`), warnings marked, and makes no write (AC-014, AC-015; also in workerd). A save after another admin's save is refused with "Reload to see the current configuration" via `settings.compareAndSet` against the per-user revision in `admin:rev:{userId}`, and succeeds after Reload (AC-016). Editors and anonymous requests are refused on page, widget, validate, save, test and reload with zero bridge calls; in workerd the host's `plugins:manage` permission refuses them first (AC-017). Validate writes nothing (FR-16). Test site shows status, code and latency and writes no buckets, snapshot or kv (AC-025, AC-026). `snapshot:config-error` renders as a persistent error banner. YAML over 64 KiB is refused with zero bridge calls, nothing truncated. The widget shows overall status plus Operational/Degraded/Major outage counts in ≤ 2 calls (FR-12). Manual pass in a staged `apps/emdash-demo` (screenshots in `/tmp/t009-shots/`): page, invalid save, validate and save work in the real admin; Test site against a loopback fixture was refused by the host ("non-public IP"); the widget showed "Waiting for the first check" with no cron tick.
- [x] (2026-10-22 20:30 KST) T012 Document installation and operation, and register both packages for release — `e0832b1`, `f545615`, `3acd186`
  Evidence: build 7/7 (the docs build emits `guides/emdash/`, Nimbus link and frontmatter checks pass), typecheck 11/11, lint clean, `bun test` → 466 pass, `bun run test:host` → 26 pass in the track tree. The guide `apps/docs/src/content/docs/guides/emdash.mdx` (Guides sidebar; the task text's root `emdash.md` was replaced by the existing guides layout) states "The engine plugin needs a **sandbox runner**" (AC-028); "Treat in-process mode as a decision to trust this package with your site's full authority, not as a workaround for a missing runner" (AC-029); "The engine plugin lives inside the CMS. If the CMS or its host goes down, checks and the status page go down with it." and "The standalone deployment plus `@statusbeam/emdash-ui` pointed at it keeps checks and the status page independent of a CMS or host outage." (AC-030); and covers `network:request:unrestricted`, the 8 MiB / 10 s / killed-run probe limits, the capacity table, and the missing `Access-Control-Allow-Origin` and `Cache-Tag`. `emdash-plugin` and `emdash-ui` are in `release-please-config.json`, `.release-please-manifest.json` (0.0.0) and the `publish.yml` tag map, each with a `CHANGELOG.md`; both validate against release-please 17.11.2's schemas and load through `Manifest.fromManifest` with a stubbed GitHub client (the remote dry run needs the network). `bun pm pack --dry-run`: the plugin ships `dist/` (core bundled) plus the manifest; emdash-ui ships source without tests. CI runs the plugin host tests after Build; eslint ignores `**/.emdash/**`; tech-stack.md has an EmDash section.
- [x] (2026-10-22 20:55 KST) Deadline follow-up on Worker Loader — `4d41861`, `7d07a35`
  Evidence: a spike cron task racing the 120 s stream against a 10 s timer was killed by EmDash's default 5 s hook timeout (`Hook timeout after 5000ms`, fetch cancelled, nothing written). With `timeout: 25_000` on the hook, two runs graded the hung probe `down` at 10 000 ms, both later probes reached the fixture, and the closing KV write landed (wall 10.0 s and 11.1 s). The engine's `cron` hook now declares `CRON_HOOK_TIMEOUT_MS` (25 s), written to the manifest as `{ name: 'cron', timeout: 25000 }`; `bun test` → 467 pass, host tests 26 pass, build/typecheck/lint green. Recorded in ADR-0004. The spike's two Workers, D1, R2 bucket and KV namespace were then deleted (the user approved the teardown).

## Decision Log

- 2026-10-22: Architecture follows ADR-0004 as amended in #99. No competing architect pass, because the spec leaves no strategy open.
- 2026-10-22: Plan review (deep, 6 lenses) applied 6 fixes: notification secret fields owned by T005, URL-free delivery logs, webhook/cron bucket race, webhook rejection order under host-parsed input, a runnable parity method, and component checks via the demo site.
- 2026-10-22: The plan has 12 tasks covering two packages. The single-track ruling was made at spec review (the user kept one track), so the Phase 4 scope prompt was not repeated.

- 2026-10-22: After the spike, the user chose a 10 s per-probe deadline graded `down`, budgeting calls before each task instead of recording a skipped outcome, and sharding each run across cron tasks. AC-010/011/012/021 were reworded and AC-031 added; T004, T005 and T008 follow.
- 2026-10-22: The engine stays a sandboxed plugin; only the optional Portable Text block needs a native entry point. A native engine is not registry-installable, runs with full site authority, and in-process mode was measured on Node only.
- 2026-10-22: T004 moved bucket pruning from every shard run to a daily `maintenance` cron task (a full shard already spends all 10 calls), runs a shard's probes concurrently (six sequential 10 s misses would pass the 30 s wall limit), and keeps the snapshot per shard (`snapshot:{i}`, latest result per monitor) with a merging reader for T006. The fixed overhead is read config, read today's buckets, `putMany`, write snapshot; T005 raises `SHARD_RESERVED_CALLS` for its snapshot read and deliveries.
- 2026-10-22: T011 added a third entry point, `./plugin` (`createPlugin` → `definePlugin` with only `admin.portableTextBlocks`), next to `./block` (the native descriptor, type-only `emdash` import) and `./astro` (`blockComponents`), because EmDash imports `createPlugin` from the descriptor's `entrypoint` and a runtime `emdash` import in `./block` breaks loading a site's `astro.config`. `emdash` is an optional peer; a small type shim keeps `astro check` passing without adding it to the root lock. Each block carries its own source URL (the renderer gets only the block's data); non-http(s) URLs render the unavailable state.
- 2026-10-22: Monitor capacity with notifications: each shard reserves one call per configured destination and coalesces one delivery per destination per run, and the snapshot read is part of the fixed overhead, so a shard probes 10 − 5 − destinations monitors (4 with Slack alone, about 32 per cadence under `MAX_SHARDS` 8). Each shard snapshot also carries its monitors' 90-day day stats so public routes read only snapshots.
- 2026-10-22: T005 reads config and decrypted secrets with one `settings.list` call and every shard snapshot with one `kv.list` call (so a monitor moved between shards keeps its history and pending change), giving a fixed overhead of 5. Snapshot v2 is `{monitors: {slug, result, days[90], warning?}, deliveries, capacityError?}`; T006 serializes from `readSnapshot` + `summariesFromSnapshot`. Notifications are posted by the plugin (the bridge takes no `AbortSignal`) with core's message builders. The YAML `notifications` block is ignored by the plugin; its URL and `queue` errors are T008's.
- 2026-10-22: T008 keeps the config-error record at `snapshot:config-error`, so a run learns about it from the `kv.list` it already makes (snapshot readers filter by `isSnapshot`). T009 validates with `validatePluginConfig(yaml, secretsFrom(settings.list()).secrets)`, reads the banner with `readConfigError` (one `kv.get`), and calls `reconcileShards(ctx, { clearConfigError: true })` after a successful save. The `sentryToken` secret now reaches polling (fixed after T007).
- 2026-10-22: Webhook state is owned separately from shard state: webhook rows `slug:date:webhook` and keys `snapshot:webhook:{slug}`, merged at read time (newest real result wins; days add both sources from per-day totals). Neither writer reads the other's state, so no interleaving loses counts. EmDash matches routes by exact name, so the slug is a `?slug=` query parameter, not a path segment. The two executors' Sentry secret names were unified on `sentryToken` (defined in `settings.ts`, re-exported by `config.ts`).
- 2026-10-22: Block Kit gives a form one submit and buttons inside a form carry no values, so the config page is one form (YAML, an operation select of Validate/Save/Test site, a slug field) with one Run submit, plus a separate Reload button. A save spends 4 calls of its own and gives `reconcileShards` the remaining 6; a config needing more shard changes than that shows a pending notice, finished by the next save or the daily maintenance task. Test site refuses Sentry monitors. `@emdash-cms/blocks` is declared as a dev dependency instead of relying on hoisting.

## Surprises & Discoveries

- Release order: `@statusbeam/emdash-ui` imports `@statusbeam/core/contract`, which the published core 0.2.0 lacks, so core must release in the same grouped release PR as the new packages. Check this when the release PR opens.
- The EmDash host refuses plugin fetches to private and loopback addresses ("non-public IP"), so monitors on localhost cannot be checked by the plugin. T012 should state it.
- EmDash's plugin test hosts run only under vitest inside workerd, not `bun test`. Host tests live in `packages/emdash-plugin/tests/*.host.ts` and run with `bun run test:host`; CI does not run them yet (T012 should add a step). The hosts also do not count bridge calls or enforce subrequest limits, so call-budget tests use an in-memory counting context; whether `ctx.settings.*` and `ctx.cron.*` count against the budget is still unverified.
- Resolved: an abandoned `ctx.http.fetch` does not hold a Worker Loader invocation open, but EmDash ends every hook after 5 s unless the hook declares a `timeout`, which silently killed slow shards before the 10 s deadline. The engine's `cron` hook now declares 25 s.
- `@statusbeam/core` is a devDependency of the plugin so `emdash-plugin build` bundles it; the CLI externalizes runtime dependencies.
- Executors now start with `git reset --hard <track tip>` in their worktree, which removes the cherry-pick base problem above. Root `bun run build`/`typecheck` still fail inside a nested `.claude/worktrees/*` checkout (`@statusbeam/web` cannot find its tsconfig), so gates are re-run in the track tree.
- Root `eslint .` lints the gitignored `apps/emdash-demo/.emdash/` that a demo build generates, so lint fails after a local demo run. Fix with an eslint ignore when T012 touches tooling.
- `@statusbeam/core/contract` now also re-exports the pure display helpers (`getDict`, `formatDay`, `formatUptime`, `windowUptime`, `toSeverity`) so the render library matches apps/web's labels without importing the yaml-bearing core root.
- Executor worktrees are cut from the main checkout's `main` (12da16f), not from the track branch, so they lack the track files. Their commits are cherry-picked onto the track branch, and Progress is recorded here by the lead.

## Outcomes & Retrospective

### What Was Shipped

- **`@statusbeam/core` is the single engine.** It now holds the rollup, change detection, poll selection, notification delivery, webhook helpers and config issues. It also defines the versioned public contract (`@statusbeam/core/contract`, `version: 1`). The standalone tests passed unchanged throughout.
- **`@statusbeam/emdash-plugin`** is a sandboxed engine with:
  - sharded cron checks, each planned against the 10-call bridge budget;
  - per-day buckets and per-shard snapshots;
  - coalesced Slack and webhook notifications;
  - body-limit failures recorded as unsupported;
  - raw public and badge routes byte-equal to standalone;
  - fail-closed Statuspage and Sentry webhooks;
  - a Block Kit config page and a dashboard widget.
- **`@statusbeam/emdash-ui`** provides Astro components and a contract client that never throws, plus an opt-in native Portable Text block.
- **Also delivered:**
  - ADR-0004 is Accepted, backed by spike results and a deadline follow-up on Worker Loader.
  - An EmDash guide in `apps/docs`.
  - Release registration for both packages.
  - A CI step that runs the plugin host tests.
- **Final gates in the track tree:** build 7/7, typecheck 11/11, lint clean, `bun test` 467 pass, host tests 26 pass.

### What Went Well

- **The spike gate paid off.** The spike found a 10-call bridge budget, limit errors that can be identified only by their message, and the 30 s kill. All three reshaped the design (sharding, up-front budgeting, the message classifier) before any engine code was written.
- **Moving the engine into core first** made HTTP parity a test of shared code, not of how faithfully a copy was made. T006 proved bodies byte-equal against the real standalone handlers in workerd.
- **Separating webhook state from shard state** (separate rows and keys, merged when read) removed the cron/webhook race without coordination.
- **Re-measuring on Worker Loader** caught EmDash's undocumented 5 s default hook timeout, which would have silently killed slow shards in production.

### What Could Improve

- **Executor worktrees started from `main`, not the track branch.** This forced cherry-picks and repeated `bun.lock` conflicts until executors reset to the track tip. Root build and typecheck also fail in nested worktrees, so every gate had to run twice.
- **Two executors chose different names for the same Sentry secret** (`sentryAuthToken` vs `sentryToken`), and the token was never wired into polling (fixed in `f6ffaeb`). Shared identifiers across parallel tasks belong in the plan up front.
- **The full demo install was never run end to end.** The engine was exercised by host tests and the spike, and the components and block by the local demo, but never together under a sandbox runner.
- **The live parity check needed a proxy** because the deployed standalone predates the contract. Redeploying standalone first would have allowed a direct check.

### Tech Debt Created

- The full `apps/emdash-demo` install with the engine under a sandbox runner has not been verified.
- Whether `ctx.settings.*` and `ctx.cron.*` count against the Worker Loader bridge budget is unverified. The budget assumes they do.
- `@statusbeam/core` must be released together with `emdash-plugin` and `emdash-ui`. Published core 0.2.0 has no `./contract` export.
- `statusbeam-web` (demo.statusbeam.dev) needs a redeploy before `emdash-ui` can read it without a `version: 1` proxy.
- A config save reconciles at most about 3 shard operations. Larger changes wait for the next save or the daily maintenance task.
