# ADR 0004 — EmDash distribution: sandboxed engine plugin + native render package

- **Status:** Proposed
- **Date:** 2026-10-21
- **Deciders:** StatusBeam maintainers

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
| Can render page HTML | No — `page:fragments` and Astro components are trusted-only | Yes — Astro components via `componentsEntry` |
| Admin UI | Block Kit only | React or Block Kit |

Four facts about StatusBeam and the EmDash host shape the decision:

1. **The check engine compiles against the sandbox, but its HTTP semantics change.**
   `checkSite(site, { fetchImpl })` already takes an injected fetch
   (`packages/core/src/check.ts:44`), and `packages/core` depends only on `zod` +
   `yaml`, so it can be bundled into a sandboxed plugin and run on `ctx.http.fetch`.
   That fetch is not equivalent to the Worker's, though: it buffers the complete
   response body before resolving and rejects bodies over 8 MiB decoded. `checkHttp`
   stops its latency timer when `fetch` resolves and never reads the body
   (`packages/core/src/check.ts:63-87`), so on the Worker it measures time to
   headers, while in the sandbox it measures time to the last body byte. A slow
   body can push a healthy monitor to `degraded`; a body over 8 MiB or a response that
   never completes fails as `down` (`code: 0`). Under-limit streaming responses are
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

Shipping only a sandboxed plugin leaves EmDash sites with no way to render a status
page. Shipping only a native plugin rules out registry install and needs full site
authority. Shipping the full engine in *both* formats means a site that installs
both runs every check twice, and nothing in EmDash prevents that.

## Decision

Ship StatusBeam for EmDash as **two packages with one engine**:

1. **`plugin-sandboxed` (registry) — the engine.** A `SandboxedPlugin` that owns:
   - the `cron` hook running `checkSite` with `ctx.http.fetch`;
   - check history in `ctx.storage`, the current snapshot in `ctx.kv`;
   - status-change notifications (Slack / webhooks), tokens in encrypted `ctx.settings`;
   - public JSON and shields.io badge routes, plus public webhook routes for
     Statuspage / Sentry ingest;
   - a Block Kit admin page for monitors and settings.

2. **`@statusbeam/emdash-ui` (npm, native) — rendering only.** A native plugin that
   ships Astro components (status banner, 90-day bars, per-site detail) and **no
   hooks, cron, or storage**. It fetches the public JSON from a configured base URL.

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
   warning on that monitor. It does not silently switch a configured `GET` to
   `HEAD`, which would change the check.

Because of (3), the render package can point its base URL at either source:

- **the sandboxed plugin's route** — "everything in EmDash";
- **a standalone StatusBeam deployment's `/api/*`** — the EmDash site only displays
  status; the page and engine stay independent of the CMS.

**Why this split:** the engine lives in exactly one package, so checks can't run
twice (fact 3 turns into a guarantee: the UI *can't* touch engine state). Rendering
requires native authority anyway, and isolating it in a hook-free package keeps the
trusted surface small. The shared contract lets the same UI serve both deployment
shapes instead of building a separate display-only plugin.

## Consequences

### Positive

- One engine implementation for EmDash; the native package can't double-run checks.
- `packages/core` code is reused by the engine without a fork (within the probe
  contract); the new JSON schema also tightens the existing standalone `/api/*`
  routes.
- The render package works against standalone StatusBeam, so EmDash sites can show
  status without accepting the CMS-coupled engine.
- The engine is registry-installable; only the small, read-only UI needs trust.

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
- New workspaces under `packages/` for the two plugins; release-please config grows.
- Contract changes to the public JSON become versioned, breaking-change-aware events.

## Alternatives Considered

- **Display-only plugin, standalone StatusBeam does the work.** Lowest risk and keeps
  every invariant, but offers nothing to sites that want monitoring managed in
  EmDash. Not rejected so much as absorbed: it is the render package pointed at a
  standalone deployment.
- **Sandboxed engine only.** Registry-installable, but cannot render a page; every
  site would have to build its own templates against the JSON.
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
  HTTP responses through `ctx.http.fetch` on both runners (Worker Loader and
  Node/workerd) and confirm the graded results match the probe contract in
  Decision (4)._
- _TODO: confirm the sandbox fetch's buffering-limit rejection is distinguishable
  from a network failure (error type or code), so the check-time guard in
  Decision (4) can classify it without masking a real outage; and decide how the
  unsupported outcome is represented, since `CheckStatus` today is only
  `up` / `degraded` / `down`._
- _TODO: confirm a `response: "raw"` public route keeps `cacheControl` and returns
  `application/json` byte-identical to the standalone `/api/status.json`._

- _TODO: minimum `ctx.cron.schedule()` interval — does it support the current
  5-minute cadence?_
- _TODO: subrequest / CPU limits per `cron` invocation on the Cloudflare Worker
  Loader runner, and how many sites one run can probe._
- _TODO: `ctx.storage` query cost for 90 days of history per site; whether to
  store raw checks or pre-aggregated day buckets._
- _TODO: whether a native plugin's Astro component can fetch a same-site public
  plugin route during SSR without a network round trip._

## References

- ADR-0002 — Package-based distribution (`0002-package-based-distribution.md`)
- `ARCHITECTURE.md` — Architecture Invariants
- EmDash plugin docs: `creating-plugins` skill — `references/sandbox-boundaries.md`,
  `references/hooks.md` (cron), `references/storage.md`, `references/api-routes.md`
