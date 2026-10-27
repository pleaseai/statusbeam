# ADR-0004: EmDash distribution: sandboxed engine plugin + Astro render library

## Status

Superseded by [ADR-0005](0005-emdash-native-plugin.md)

Accepted on 2026-10-22, after the probe-semantics spike revised it (see Spike results).

**Deciders:** StatusBeam maintainers

## Date

2026-10-21

## Context

[EmDash](https://github.com/emdash-cms) is an Astro-based CMS that can be extended
with plugins. It runs plugins on Cloudflare (Worker Loader) as well as Node/workerd,
so an EmDash site on Cloudflare runs on the same platform StatusBeam targets.
"StatusBeam inside an EmDash site" is therefore a natural distribution channel
alongside the standalone packages of ADR-0002.

EmDash offers two plugin formats with different authority:

| | Sandboxed | Native |
|---|---|---|
| Entry | `src/plugin.ts` default-exports a `SandboxedPlugin` | `definePlugin()` / `createPlugin()` |
| Install | Registry, after admin approval of declared capabilities | Trusted site dependency only (code + config change) |
| Portable Text block renderers | No — the site must supply one | Yes — Astro renderers via `componentsEntry` |
| Raw HTML/scripts in pages | No — `page:fragments` is trusted-only | Yes |
| Admin UI | Block Kit only | React or Block Kit |

EmDash's format guide names only three needs that require a native plugin: a custom
React admin, custom Portable Text block types, and raw HTML or scripts through
`page:fragments`. Rendering a page is not one of them. An EmDash site is an Astro
site, so its own pages can import Astro components from an ordinary npm package
without installing any plugin.

Five facts about StatusBeam and the EmDash host shape the decision:

1. **The check engine compiles against the sandbox, but its HTTP semantics change.**
   `checkSite(site, { fetchImpl })` already takes an injected fetch
   (`packages/core/src/check.ts:44`), and `packages/core` depends only on `zod` +
   `yaml`, so it can be bundled into a sandboxed plugin and run on `ctx.http.fetch`.
   That fetch is not equivalent to the Worker's, though: it buffers the complete
   response body before resolving and rejects bodies over 8 MiB decoded. `checkHttp`
   stops its latency timer when `fetch` resolves and never reads the body
   (`packages/core/src/check.ts:63-87`), so on the Worker it measures time to
   headers, while in the sandbox it measures time to the last body byte. A slow
   body can push a healthy monitor to `degraded`; a body over 8 MiB fails as `down`
   (`code: 0`). A response that never completes is not rejected at all: both sandbox
   runners kill the whole invocation at 30 s, and in-process the fetch blocks (spike,
   2026-10-22). Under-limit streaming responses are
   buffered successfully, but their latency is measured to the last body byte.
   The same monitor can therefore produce false outages
   and notifications when it moves to the plugin.
2. **EmDash runtime services map onto the Worker's.** The `cron` hook +
   `ctx.cron.schedule()` replaces Cron Triggers; `ctx.storage` / `ctx.kv` replace
   D1 / KV; `public: true` routes with `cacheControl` replace `/api/*` and the inbound
   webhook endpoint. The storage and content APIs are documented as identical across
   native and both sandbox runners.
3. **Plugin storage is plugin-scoped.** A second plugin cannot read another plugin's
   storage directly; it has to go through that plugin's routes.
4. **The public JSON shape has no shared schema, and plugin routes wrap it.**
   `/api/status.json` builds its payload inline in
   `apps/web/src/pages/api/status.json.ts` from `SiteSummary` and returns it
   unwrapped. There is no core-owned type for the response. An ordinary EmDash plugin
   route wraps its handler's return value in a `{ success: true, data }` envelope;
   `public: true` and `cacheControl` do not remove it. Only a route that declares
   `response: "raw"` and returns `pluginResponse()` sends an unwrapped body
   (`application/json` is allowed; HTML, SVG, and other active types are not).
5. **A sandboxed plugin runs in one of three modes, and needs a runner for two of
   them.** Listed in `sandboxed: []`, it runs isolated under the site's configured
   `sandboxRunner`: Worker Loader (`sandbox()` from `@emdash-cms/cloudflare`) or a
   `workerd` child process on Node (`@emdash-cms/sandbox-workerd/sandbox`). The
   runners enforce different fixed limits per invocation: Worker Loader caps CPU
   time (50 ms), subrequests (10), and wall time (30 s); the Node/workerd runner
   enforces only the 30 s wall time. Neither enforces a per-plugin memory limit.
   With no runner configured, or with a runner the platform cannot provide, plugins in
   `sandboxed: []` do not load, and EmDash only logs a startup warning. A site can
   instead list the same plugin in `plugins: []` to run it in-process: capability
   gating still applies, but there is no isolation and no per-plugin resource limit.
   The EmDash docs do not say whether `ctx.http.fetch` buffers bodies the same way
   in-process as under the two runners (fact 1).

Shipping only a sandboxed plugin leaves every EmDash site to build its own status
page templates against the JSON. Shipping only a native plugin rules out registry
install and needs full site authority. Shipping the full engine in *both* formats
means a site that installs both runs every check twice, and nothing in EmDash
prevents that.

## Decision

Ship StatusBeam for EmDash as **two packages with one engine**:

1. **`plugin-sandboxed` (registry) — the engine.** A `SandboxedPlugin` that owns:
   - the `cron` hook running `checkSite` with `ctx.http.fetch`. Each 5-minute run is
     sharded across several cron tasks, because every bridge call (fetch, KV, storage,
     settings, log) counts against Worker Loader's 10-call budget per invocation, which
     leaves about 6 monitors per task. The shard count stays within the scheduler's
     10-due-tasks-per-tick limit. Each task plans its bridge calls before spending any
     and never starts a probe it cannot afford;
   - check history in `ctx.storage`, the current snapshot in `ctx.kv`;
   - status-change notifications (Slack / webhooks), tokens in encrypted `ctx.settings`;
   - public JSON and shields.io badge routes, plus public webhook routes for
     Statuspage / Sentry ingest. `public: true` removes host authentication, so the
     webhook routes keep the standalone endpoint's auth: fail closed when no secret
     is configured, and compare the `?token=` query value against it in constant
     time (`timingSafeEqual`, `apps/worker/src/webhook.ts:103-105`). The secret
     lives in encrypted `ctx.settings`. A query token, not a header, carries it,
     because EmDash strips credential headers at the route boundary;
   - a Block Kit admin page for monitors and settings.

2. **`@statusbeam/emdash-ui` (npm) — rendering only, not a plugin.** A plain Astro
   component library (status banner, 90-day bars, per-site detail) that the site
   imports into its own pages. It has no `definePlugin()`, no hooks, cron, or
   storage, and needs no EmDash plugin registration or capability approval. It is
   still a trusted site dependency: its components run as site code during SSR,
   outside any sandbox. It fetches the public JSON from a configured base URL.
   - **Optional native Portable Text block.** For sites that want editors to embed
     status inside content, the package also ships an opt-in native plugin entry
     point for a "status" Portable Text block. It needs both halves EmDash requires:
     the editor definition in `admin.portableTextBlocks` (`type: "statusbeam-status"`
     plus its fields), so editors can insert the block, and a `componentsEntry`
     module exporting `blockComponents` keyed by that same `type`, rendering with
     the same library components. It is the only StatusBeam code registered as a
     native plugin, and it too has no hooks, cron, or storage.

3. **A core-owned wire contract.** Move the public status response into
   `packages/core` as a zod schema + type (`statusResponseSchema`, per-site response).
   Both the standalone `apps/web` `/api/*` routes and the sandboxed plugin's routes
   produce it, and the render package parses it. The contract covers the HTTP wire,
   not just the handler's return value:
   - the plugin's public status, per-site, and badge routes declare
     `response: "raw"` and return `pluginResponse()` with an `application/json`
     body, so they emit the same unwrapped top-level shape as the standalone
     endpoints (and a valid shields.io endpoint body for badges);
   - the route path mapping from standalone `/api/*` to the plugin's routes is part
     of the contract, so the render package changes only its base URL;
   - HTTP-level parity tests compare the plugin routes' responses with the
     standalone endpoints, rather than validating only pre-envelope handler objects.

4. **A documented probe contract for the plugin engine.** Because sandbox fetch
   buffers the full body (fact 1), the plugin engine supports only monitors whose
   graded result does not depend on header-time behavior: responses under the 8 MiB
   body limit, with latency defined as time to the full body. Monitors outside that
   contract stay on standalone StatusBeam. The plugin warns about known-unsupported
   monitors at configuration time, but response size and streaming are properties
   of each future response, so the decisive guard runs at check time: when
   `ctx.http.fetch` rejects because of the buffering limit, the engine records the
   probe as unsupported rather than `down`, leaves it out of status and uptime
   rollups, sends no status-change notification for it, and shows a persistent
   warning on that monitor. The rejection carries no error code, so the engine
   matches it by message text, before treating any other rejection as a network
   failure. It does not silently switch a configured `GET` to `HEAD`, which would
   change the check. Every probe also runs under a 10 s plugin-side deadline; a probe
   that misses it grades `down` (`code: 0`), like a network failure, so one
   never-completing response cannot end the invocation and lose the other probes.
   Subrequest, CPU, and wall-time limits cannot be recorded after they hit (later
   bridge calls fail, and CPU or wall-time kills never reach the plugin), so the
   engine budgets calls up front instead. A run that a platform limit still kills
   writes nothing, which leaves the last snapshot, and every monitor's status,
   unchanged.

Because of the wire contract (Decision 3), the render package can point its base
URL at either source:

- **the sandboxed plugin's route** — "everything in EmDash";
- **a standalone StatusBeam deployment's `/api/*`** — the EmDash site only displays
  status; the page and engine stay independent of the CMS.

**Why this split:** the engine lives in exactly one package, and the render package
is not a plugin at all, so installing both can't run checks twice. Rendering a page
is not one of the format guide's native-only needs (Context), so the common case
registers no StatusBeam plugin with the host: no capability approval, and no hooks,
routes, or admin surface beyond the engine's. That does not make the renderer
untrusted-safe. Both the component library and the optional Portable Text block run
as site code outside the sandbox, with the site's full authority, like any other
server-side dependency the site imports. Both are designed to consume only the
public JSON and never engine state; that is a constraint their implementation keeps,
not a boundary the host enforces, and plugin-scoped storage (Context fact 3) isolates
storage access only between plugins through the plugin API. Keeping the renderer
hook-free, storage-free, and its native entry point opt-in keeps the trusted surface
small. The shared contract lets the same UI serve both deployment shapes instead of
building a separate display-only plugin.

## Consequences

### Positive

- One engine implementation for EmDash; the render package can't double-run checks.
- `packages/core` code is reused by the engine without a fork (within the probe
  contract); the new JSON schema also tightens the existing standalone `/api/*`
  routes.
- The render package works against standalone StatusBeam, so EmDash sites can show
  status without accepting the CMS-coupled engine.
- The engine is registry-installable, and the component library needs no plugin
  registration or capability approval; only the optional Portable Text block is
  registered as a native plugin. Both remain trusted site dependencies that site
  operators review like any other server-side package.

### Negative

- **"The page must survive the outages it reports" no longer holds** when the engine
  runs in the plugin: a CMS or host outage takes checks and page down together. The
  standalone-backed mode keeps the guarantee; docs must say which mode does.
- The engine needs `network:request:unrestricted`, because monitored hosts change at
  runtime and an `allowedHosts` list would require admin re-approval on every change.
- Plugin-engine latency is time to the full body, not time to headers, so its
  numbers are not directly comparable with a standalone deployment's, and some
  monitors (bodies over 8 MiB, or responses that never complete) are
  standalone-only.
- A second persistence back end: per-day uptime aggregation currently runs as SQL
  `GROUP BY` over D1 (`writeSummary()`); in the plugin it must be computed over
  `ctx.storage`. Two implementations of the same rollup must agree.
- Instant Cache-Tag purge probably does not carry over — the host owns caching
  headers on plugin routes, so the plugin path likely falls back to TTL
  (`cacheControl`). _TODO: confirm against the EmDash host._
- **A sandbox runner is required.** Installed as designed (`sandboxed: []`), the
  engine does not load on a site with no `sandboxRunner` configured or with a runner
  its platform cannot provide, and EmDash only logs a startup warning (Context
  fact 5). The install docs must state this up front. Listing the engine in
  `plugins: []` makes it load without a runner, but runs it in-process with no
  isolation or resource limits, so the docs must present that as a trust decision,
  not a workaround.
- Users who want everything in EmDash install two packages from two places
  (registry + npm).
- Config moves from `status.config.yml` to plugin settings / Block Kit, which departs
  from the "single YAML validated only by core" invariant for this channel.
  _TODO: choose where the plugin engine's monitor config lives. Whichever option
  wins, the engine still validates it through core's `configSchema` /
  `parseConfig`. The options:_

  | Option | How it works | Trade-off |
  |---|---|---|
  | Block Kit admin page | Plugin `ctx.settings` edited through a plugin-owned Block Kit form | Self-contained in the sandboxed plugin; we build and maintain the form |
  | YAML stored as-is in settings | One text setting holding `status.config.yml`, parsed by `parseConfig` | Keeps the single-YAML invariant and parity with standalone; poor editing UX |
  | `json` field + `field-kit:list` | Monitors are a `json` field on a content entry, edited with the first-party native Field Kit widget; the engine reads it through `ctx.content` (`content:read`) | No form to build, values stay plain JSON; but the site must install a native plugin, seed the collection (plugins cannot create schema), and config becomes CMS content subject to its revisions and permissions |
  | `json` field + plugin `admin.fieldWidgets` | Same storage as above, edited with a declarative Block Kit field widget shipped by our own sandboxed plugin | Registry-installable with no Field Kit dependency; still needs a seeded collection, and EmDash's browser E2E covers only a native React widget, so editor render and value persistence are unverified |

### Neutral

- ADR-0002's standalone packages remain the primary distribution; this adds a channel.
- New workspaces under `packages/` for the engine plugin and the component library;
  release-please config grows.
- Contract changes to the public JSON become versioned, breaking-change-aware events.

## Alternatives Considered

- **Display-only plugin, standalone StatusBeam does the work.** Lowest risk and keeps
  every invariant, but offers nothing to sites that want monitoring managed in
  EmDash. Not rejected so much as absorbed: it is the render package pointed at a
  standalone deployment.
- **Sandboxed engine only.** Registry-installable, but cannot render a page; every
  site would have to build its own templates against the JSON.
- **Render package as a native plugin.** An earlier draft of this ADR shipped the
  Astro components inside a `definePlugin()` native plugin. Rendering a page is not
  one of EmDash's native-only needs, so that form would add a plugin registration,
  config change, and hook surface that the renderer does not use, for every site that
  only wants to display status. It would not change the renderer's authority: a
  plain library imported into site pages runs with the same full site authority. The
  native plugin form is kept for the optional Portable Text block, the one piece
  that needs `componentsEntry`.
- **Native plugin only (full port).** Most capable and could reuse `StatusPage.astro`
  and possibly D1 SQL, but not registry-installable, runs with full site authority,
  and makes the whole app a second host to maintain.
- **One engine, two shells (sandboxed + native, each with the engine).** A single
  package for native users, but both installed means duplicate cron runs with no
  host-level guard, and the native shell would not serve standalone deployments.
  It also assumes `definePlugin()` accepts the same hooks shape as
  `SandboxedPlugin`, which is unverified.

## Open Questions (spike before Accepted)

- _TODO: acceptance gate for probe semantics — run large, slow-body, and streaming
  HTTP responses through `ctx.http.fetch` in all three execution modes (Context
  fact 5): the Worker Loader runner, the Node/workerd runner, and in-process
  (`plugins: []`), and confirm the graded results match the probe contract in
  Decision (4). If in-process fetch does not buffer, the probe contract must say
  which mode it describes, or the engine must refuse to run in-process._
- _TODO: confirm the sandbox fetch's buffering-limit rejection is distinguishable
  from a network failure (error type or code), so the check-time guard in
  Decision (4) can classify it without masking a real outage; and decide how the
  unsupported outcome is represented, since `CheckStatus` today is only
  `up` / `degraded` / `down`._
- _TODO: confirm a `response: "raw"` public route keeps `cacheControl` and returns
  `application/json` byte-identical to the standalone `/api/status.json`._

- _TODO: minimum `ctx.cron.schedule()` interval — does it support the current
  5-minute cadence?_
- _TODO: how many sites one `cron` invocation can probe under Worker Loader's
  10-subrequest and 50 ms CPU caps (fact 5), counting notification deliveries as
  subrequests too, and whether the engine must split a run across invocations._
- _TODO: `ctx.storage` query cost for 90 days of history per site; whether to
  store raw checks or pre-aggregated day buckets._
- _TODO: EmDash's Portable Text page says a sandboxed plugin can declare
  `admin.portableTextBlocks` without `componentsEntry`, with the site passing its
  own renderer; this is unverified against the EmDash source. Confirm it, and
  whether the engine plugin could declare the status block and the site map it to
  a library component, which would remove the native entry point for plugin-engine
  sites (standalone-backed sites would still need it)._
- _TODO: whether a component-library component rendered during the site's SSR can
  fetch a same-site public plugin route without a network round trip._

## Spike results (2026-10-22)

The probe-semantics spike (issue #100, harness in `apps/emdash-demo`) ran the real
`checkSite` from `@statusbeam/core` with `fetchImpl` set to `ctx.http.fetch` inside a
sandboxed probe plugin. The probe ran in each of the three execution modes against a
fixture Worker. The setup:

- EmDash 1.3.1, `@emdash-cms/cloudflare` 1.3.1, and `@emdash-cms/sandbox-workerd` 0.9.5,
  which spawned workerd 1.20260730.1.
- The Node modes ran on Node 24.20.0 (macOS).
- The Worker Loader site was deployed as the `statusbeam-emdash-spike` Worker on a
  Workers paid account.
- Every site used `maxResponseTime: 2000`.
- Each fixture case ran as its own plugin invocation.

The README in `apps/emdash-demo` reproduces every run. The raw output is in
`apps/emdash-demo/results/2026-10-22/`.

### Probe fixtures (FR-1, AC-001, AC-002)

Each cell shows the graded `CheckResult` as status, `code`, and `responseTime`.

| Fixture | Worker Loader | Node/workerd | In-process | Probe contract (Decision 4) |
|---|---|---|---|---|
| 7 MiB body, sent fast | `up` 200, 125 ms | `up` 200, 1526 ms | `up` 200, 423 ms | Holds |
| 9 MiB body (over 8 MiB) | `down` 0, 189 ms; fetch rejects | `down` 0, 514 ms; fetch rejects | `down` 0, 201 ms; fetch rejects | Holds: the body limit rejects in every mode (see FR-2) |
| Headers after 3 s (control) | `degraded` 200, 3009 ms | `degraded` 200, 3591 ms | `degraded` 200, 3303 ms | Holds |
| Headers at once, body done at 3 s | `degraded` 200, 3008 ms | `degraded` 200, 3566 ms | `degraded` 200, 3235 ms | Holds: latency is time to the last body byte in every mode, so in-process buffers too |
| Stream that completes at 20 s | `degraded` 200, 20008 ms | `degraded` 200, 20251 ms | `degraded` 200, 20120 ms | Holds: buffered, latency to the last byte |
| Stream that runs 120 s (past the 30 s wall time) | No result. The host kills the invocation at 30 s with `Plugin statusbeam-spike-probe exceeded wall-time limit of 30000ms` | No result. Same 30 s kill and message | `degraded` 200, 120233 ms. No limit applies, so the probe blocks until the body ends | **Contradicts.** The contract expects `down` (`code: 0`) and a check-time guard. No mode rejects the fetch, so the guard never runs |
| HTTP 503 | `down` 503 | `down` 503 | `down` 503 | Holds (target error) |
| Unresolvable host (`.invalid`) | `down` 530. Cloudflare answers with an error response, and the fetch does not reject | `down` 0. The fetch rejects in the SSRF DNS pre-check | `down` 0. Same rejection as Node/workerd | Network failures look different per mode (see FR-2) |

A plugin-side timer is a workaround for the 120 s stream. The probe raced `ctx.http.fetch`
against a 10 s `Promise.race` timer on Worker Loader, because the bridge takes no
`AbortSignal`. The result was `down` 0 at 10000 ms, and the invocation survived.

### Limit rejections versus network failures (FR-2)

None of the rejections below carries an error code. Each is a plain `Error`, so a
classifier can tell them apart only by message text.

| Limit | Worker Loader | Node/workerd | In-process |
|---|---|---|---|
| Body over 8 MiB | `ctx.http.fetch` rejects with `Error: Plugin HTTP response body exceeds the 8388608 byte limit`. The plugin can catch it | Rejects, with the same text wrapped as `Bridge call http/fetch failed: {"error":"Plugin HTTP response body exceeds the 8388608 byte limit"}` | Rejects with the unwrapped Worker Loader text |
| Subrequests (10 per invocation) | The 11th bridge call rejects with `Error: Too many subrequests by single Worker invocation. To configure this limit, …`. The plugin can catch it, and every later bridge call fails too | Not enforced: 30 probes plus 30 KV and log calls all succeeded | Not enforced |
| CPU time (50 ms) | The plugin cannot catch it. The invocation fails, the route answers `ROUTE_ERROR` `Worker exceeded CPU time limit.`, and cron logs `[cron] Hook failed … Worker exceeded CPU time limit.` | Not enforced: 5000 `parseConfig` runs took 6.4 s | Not enforced |
| Wall time (30 s) | The plugin cannot catch it. The invocation fails with `exceeded wall-time limit of 30000ms` | Same as Worker Loader | Not enforced |
| Network failure | DNS failure arrives as an HTTP 530 response, not a rejection | DNS failure rejects as `Bridge call http/fetch failed: {"error":"Plugin … blocked fetch to … Hostname resolved to no addresses"}` | Rejects as `Plugin "…": blocked fetch to "…": Hostname resolved to no addresses` |

Two conclusions follow:

- The body-limit and subrequest-limit rejections can be told apart from a network failure
  by matching message text, in a mode-tolerant way (a substring match, not equality).
- The CPU-time and wall-time limits never reach the plugin. They end the whole
  invocation, so the invocation cannot record its own probes as skipped.

### Capacity per run (FR-3, AC-003)

These rows ran on Worker Loader. The two Node modes enforce no subrequest or CPU limit,
and every one of their runs completed.

| Run | Result |
|---|---|
| 8, 9, or 10 probes | All finished. |
| 12 probes | Run completes but truncates: probes 1–10 finished, probes 11–12 failed with the subrequest error. `checkHttp` graded them `down` 0. |
| 20 probes | Probes 1–10 finished; the other 10 failed the same way. |
| 6 probes + 3 notification POSTs | All finished (9 bridge calls). |
| 0 probes + 12 KV writes, or + 12 `ctx.log` calls | The first 10 succeeded and the next 2 failed. **KV and log calls count against the same 10-subrequest budget.** |
| 10 probes + 1 `putMany` | `putMany` failed. One `putMany` costs 1 subrequest whatever its size (20 and 100 items both fit beside 9 probes). |
| Cron task, 12 probes | The fixture Worker received probes 1–10. The closing KV write of the run summary failed, so the run left no record. |
| 3 cron tasks of 8 probes, same tick | All 24 probes finished. Each cron task is its own invocation with its own 10-call budget. |
| `parseConfig` on a 25-monitor config (FR-20) | Locally (`scripts/bench-parse.ts`, 6 runs) a warm parse costs 1.4–1.7 ms in 5 runs and 5.9 ms in 1. The first, cold parse costs 20–70 ms. A cold first parse on Worker Loader never failed. On Worker Loader, up to 600–1000 parses fit in one invocation on a fresh isolate. 1250 or more parses hit the CPU limit, and right after such kills, 750 parses failed too. The 50 ms limit is not a fixed budget measurable from inside the plugin. One parse per run is far below it either way. |

The capacity math has these terms:

- Every bridge call costs one subrequest. The spike measured this for
  `ctx.http.fetch`, `ctx.kv.*`, `ctx.log.*`, and `ctx.storage.*.putMany`. It assumes
  the same for `ctx.settings.*` and `ctx.cron.*`, which also go through the bridge
  binding; T004 should confirm it.
- One run of the engine as designed costs `n + m + k` calls:
  - `n` probes;
  - `m` notification deliveries;
  - a fixed `k` of about 4 calls: read the config and the snapshot, write the buckets
    with one `putMany`, and write the snapshot.
- The 10-call budget therefore fits at most about 6 monitors with no notifications.
  _(Implemented, 2026-10-22: the shipped engine also reads every shard snapshot with one
  `kv.list` and today's buckets with one `getMany`, so `k` is 5 (`SHARD_FIXED_CALLS`).
  A shard fits 5 monitors with no notifications and 4 with Slack alone; see the
  capacity table in the EmDash guide.)_

A run must be split across invocations. The cron executor gives each due task its own
invocation, but it claims at most 10 due tasks per tick across the whole site
(`LIMIT 10` in `CronExecutor.tick`) and runs them one after another.

### Cron interval (FR-4)

| Schedule | Worker Loader | Node/workerd | In-process |
|---|---|---|---|
| `*/5 * * * *` | Accepted. Ran at 07:45:17, 07:50:17, and 07:55:17 UTC. | Accepted. Ran at :00 every 5 minutes. | Accepted. Ran at :00. |
| `* * * * *` | Ran every minute, about 17–18 s after the minute. | Ran every minute. | Ran every minute. |
| `*/10 * * * * *` (seconds field) | Accepted, but ran once a minute. | Ran every 10 s. | Ran every 10 s. |
| An invalid expression | Rejected with `Invalid schedule "…": must be a valid cron expression or ISO 8601 datetime` | Same | Same |

The minimum interval is 1 minute on Cloudflare, set by the site's `* * * * *` Cron
Trigger. On Node it is about 1 s, from the scheduler's timer floor. The 5-minute cadence
works in every mode.

### Deadline follow-up on Worker Loader (2026-10-22, during implementation)

A cron task on Worker Loader raced a fetch to the 120 s stream fixture against a 10 s
plugin-side timer, then made two more probes and its closing KV write.

| Cron hook timeout | Result |
|---|---|
| EmDash default (5 s) | `Hook timeout after 5000ms`; the host cancelled the pending fetch, and no later probe or write ran. |
| `timeout: 25_000` in the hook config | The abandoned probe graded `down` (code 0) at 10 000 ms, both later probes reached the fixture, and the KV write landed (wall 10.0 s and 11.1 s over two runs). |

An abandoned bridge fetch does not hold the invocation open, but EmDash's 5 s default
hook timeout ends any cron run that waits longer. The engine therefore declares its
`cron` hook with a 25 s timeout (`CRON_HOOK_TIMEOUT_MS`), which the plugin CLI writes into
the manifest's hook entry. That covers the 10 s deadline and stays under the 30 s wall
limit.

### Spike verdict

The spike triggered the T001 STOP condition: one mode, and in one case every mode,
contradicted the probe contract as first written, so ADR-0004 was revised before Phase 3.
On 2026-10-22 the user chose a 10 s per-probe deadline graded `down`, up-front call
budgeting in place of a recorded "skipped" outcome, and sharding each run across cron
tasks. Context fact 1 and Decisions 1 and 4 reflect those choices, and the ADR was then
Accepted. The findings that drove the revision:

- **Confirmed.** Buffering, the 8 MiB limit, and latency measured to the full body hold
  in all three modes, in-process included. The open question about in-process buffering
  is closed: it buffers.
- **Contradiction 1: never-completing responses.** Context fact 1 and Decision 4 say a
  response that never completes fails as `down` (`code: 0`) and is caught at check time.
  No mode rejects such a fetch:
  - both runners kill the whole invocation at 30 s, which loses every other probe in it;
  - in-process has no limit, so the probe blocks until the body ends.

  Decision 4 needs a per-probe deadline that the engine enforces with a plugin-side timer
  well under 30 s. It also needs to say how a deadline expiry is graded. Context fact 1
  needs a matching correction.
- **Contradiction 2: limit outcomes the plan assumes it can record.** FR-13 and AC-010
  assume a probe that hits the subrequest or CPU limit can be recorded as skipped, and
  that is not true:
  - after the subrequest limit, every later bridge call fails, including the writes
    that would record the skip;
  - CPU and wall-time kills never reach the plugin.

  Revise FR-13 and AC-010 so the engine budgets bridge calls before it spends them and
  never relies on writing after a limit. Revise the T005 limit marker so it matches by
  message substring, because no error code exists.
- **Capacity.** The real budget is about 6 monitors per invocation, not 10, because
  KV, log, settings, and storage calls share the subrequest budget. This is workable only
  by sharding a run into several cron tasks, so the plan should change:
  - FR-3, NFR-2, and AC-021, plus the Decision text on the cron hook, should state
    sharding as the design;
  - the shard design has to respect the 10-tasks-per-tick claim limit.

  The Phase 3 tasks T004 and T008 should change with it.
- **Network-failure shape differs per mode.** DNS failure arrives as HTTP 530 on
  Cloudflare and as a rejection on Node. Both grade `down`, so status is correct. A
  classifier that treats any fetch rejection as "the target is down" stays correct only
  if the limit rejections are matched first.
- **No change needed.** The 5-minute cadence works everywhere (FR-4). Re-validating the
  config each run (FR-20) costs little enough CPU that caching it stays out of scope.

## References

- ADR-0002 — Package-based distribution (`0002-package-based-distribution.md`)
- `ARCHITECTURE.md` — Architecture Invariants
- EmDash plugin docs: `creating-plugins` skill — `references/sandbox-boundaries.md`,
  `references/hooks.md` (cron), `references/storage.md`, `references/api-routes.md`
- EmDash docs: [Choosing a format](https://docs.emdashcms.com/plugins/creating-plugins/choosing-a-format/)
  (native-only needs, sandbox runners, in-process `plugins: []`),
  [Plugin Sandbox](https://docs.emdashcms.com/deployment/plugin-sandbox/) (per-runner limits),
  [React admin](https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/)
