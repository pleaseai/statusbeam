# Architecture

> Agent-first bird's-eye view of the StatusBeam codebase. Describes structure and
> intent, not implementation detail. For decision rationale see `docs/adr/`.

## System Overview

**Purpose**: StatusBeam is an open-source, CDN-native status page generator — a
modern successor to [upptime](https://github.com/upptime/upptime). A cron Worker
probes your services, records uptime as time-series data, and an Astro site
renders a fast status page entirely at the edge.

**Primary users**: operators/maintainers self-hosting a public status page on
Cloudflare; the status page's own visitors (read-only); AI coding agents working
in this repo.

**Core workflow**:

1. A Cloudflare **Cron Trigger** (every 5 min) fires the check Worker
   (`apps/worker/src/index.ts`), which reads the service list from KV and probes
   each service.
2. Check results are written to **D1** (durable history) and aggregated into a
   current-status snapshot in **KV**. On a status change, the Worker fans out
   notifications (Slack/webhooks) and purges the edge cache by tag.
3. The **Astro** site (`apps/web`) renders the KV snapshot at the edge — 90-day
   uptime bars, response-time charts, incident timeline — plus a public JSON +
   badge API. The visitor's browser never calls a third-party API.

**Key constraints**: everything runs on Cloudflare edge primitives (no origin
server); the page must survive the outages it reports; a single YAML file is the
only user configuration; each build is configuration-independent (config lives in
KV at runtime, not the bundle — see ADR-0002).

## Dependency Layers

Dependencies flow downward only. Lower layers must not import upper layers.

```
┌───────────────────────────────────────────────────────────────┐
│  Interface Layer                                              │
│  apps/web  — Astro SSR pages + /api/* JSON & badge endpoints  │
│  apps/worker — Cron `scheduled()` handler                     │
├───────────────────────────────────────────────────────────────┤
│  Domain Layer                                                 │
│  packages/core — Zod schemas, checkSite, status rollups,      │
│  cache-tag defs, notify payloads, badges, i18n (framework-free)│
├───────────────────────────────────────────────────────────────┤
│  Infrastructure Layer (Cloudflare)                           │
│  D1 (history) · KV (snapshot + config) · Workers Cache        │
│  (tag-purged) · Cron Triggers · REST purge/notify             │
└───────────────────────────────────────────────────────────────┘
```

**Invariant**: `packages/core` has zero framework/runtime dependencies (only
`zod` + `yaml`) and is imported by both apps. Cloudflare and Astro types never
leak into core.

## Entry Points

For understanding **the check pipeline** (how data is produced):

- `apps/worker/src/index.ts` — `export default { scheduled() }`, the cron entry.
  Reads config from KV, runs checks, writes D1 + KV snapshot, triggers
  notify/purge. Also exports a `fetch()` handler for inbound provider webhooks at
  `POST /webhooks/:provider/:slug` (Statuspage + Sentry), which feed the same
  ingest pipeline as cron.
- `apps/worker/wrangler.jsonc` — cron schedule (`*/5 * * * *`), D1 (`DB`) and KV
  (`STATUS_KV`) bindings, and the documented Queue upgrade path.
- `apps/worker/schema.sql` — the D1 schema: `checks`, `incidents`,
  `incident_updates` + indexes.

For understanding **the status page** (how data is rendered):

- `apps/web/astro.config.ts` — `output: 'server'`, Cloudflare adapter, React
  integration, i18n locales sourced from `@statusbeam/core`.
- `apps/web/src/pages/{en,ja,ko,zh}/index.astro` — the localized pages; each
  calls `loadStatusPage(Astro)` and renders `components/StatusPage.astro`.
- `apps/web/src/lib/page.ts` / `apps/web/src/lib/data.ts` — the read path:
  parallel KV/D1 reads plus `Cache-Control` / `Cache-Tag` header emission.

For understanding **the domain model** (the shared contracts):

- `packages/core/src/index.ts` — barrel export of every core module.
- `packages/core/src/config.ts` — `configSchema` + `parseConfig(yaml)`, the
  single validated shape of `status.config.yml`.

## Module Reference

| Module           | Purpose                                             | Key Files                                                        | Depends On                          | Depended By              |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- | ------------------------ |
| `packages/core/` | Framework-free domain logic: schemas + pure fns     | `config.ts`, `check.ts`, `types.ts`, `cache.ts`, `notify.ts`, `badge.ts`, `incidents.ts`, `i18n.ts` | `zod`, `yaml` (external only)        | `apps/worker`, `apps/web` |
| `apps/worker/`   | Check engine — cron probe → D1/KV → notify + purge  | `src/index.ts`, `src/cache.ts`, `src/notify.ts`, `src/env.ts`, `schema.sql` | `@statusbeam/core`, `@cloudflare/workers-types`, `wrangler` | — (writes data web reads) |
| `apps/web/`      | SSR status page + public JSON/badge API             | `src/lib/data.ts`, `src/lib/page.ts`, `src/lib/api.ts`, `src/components/StatusPage.astro` | `@statusbeam/core`, `astro`, `@astrojs/cloudflare`, `react`, `recharts` | — (read-only consumer)    |
| `scripts/`       | Deploy orchestration (unpublished CLI)              | `setup.sh`, `apply-config.ts`                                    | `wrangler`                          | operators (`bun run setup`) |
| `docs/`          | ADRs + adapter guides                               | `adr/0001-tech-stack.md`, `adr/0002-package-based-distribution.md`, `adapters/statuspage.md` | —                                   | humans/agents            |

Root config: `package.json` (Bun `1.3.14` workspaces `apps/*`, `packages/*`),
`turbo.json` (build `dependsOn ^build`, typecheck, persistent dev), `bunfig.toml`
(hoisted linker + `[test]` coverage), `tsconfig.base.json` (strict,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, composite), `mise.toml`.

## Data Flow

**Check → store → render**

1. Cron fires → `scheduled()` in `apps/worker/src/index.ts`.
2. `loadConfig()` reads YAML from KV key `config`, validates via `parseConfig()`
   (`packages/core/src/config.ts`).
3. `checkSite(site)` probes each service — HTTP, Atlassian Statuspage, a
   Sentry Uptime monitor's issue state, or a model endpoint's published health on
   the Vercel AI Gateway / OpenRouter (`packages/core/src/check.ts`).
4. Results are batch-inserted into the D1 `checks` table (`apps/worker/schema.sql`).
5. `writeSummary()` aggregates D1 history (GROUP BY slug/day) into a
   `SiteSummary[]` snapshot and writes KV key `summary`.
6. Web reads KV `summary`/`incidents` (`apps/web/src/lib/data.ts`);
   `loadStatusPage()` renders `StatusPage.astro`. `/api/*` routes read the same
   snapshot.

**Status change → notify + purge**

1. `readSummary()` loads the previous snapshot; `changed` = slugs whose status
   differs from the prior run.
2. `buildStatusChangePayload()` (`packages/core/src/notify.ts`) builds a
   channel-agnostic payload.
3. `ctx.waitUntil(dispatchNotifications(...))` (`apps/worker/src/notify.ts`) —
   Slack (`toSlackMessage`) + generic webhooks via `Promise.allSettled`; failures
   are logged, never thrown.
4. `ctx.waitUntil(purgeStatusCache(...))` (`apps/worker/src/cache.ts`) — POSTs
   Cloudflare `purge_cache` with `cacheTags(slugs)`. Web emits the matching
   `Cache-Tag` header (`src/lib/page.ts`, `src/lib/api.ts`), so purge invalidates
   cached pages/APIs instantly instead of waiting for TTL.

## Architecture Invariants

**core is framework-free.** `packages/core` may depend only on `zod` and `yaml`.
Adding a Cloudflare/Astro/React import to core violates the layering and breaks
its reuse across both apps. Both apps import core; core imports neither.

**Edge-only rendering — the browser never calls a third-party API.** Only the
Worker probes upstreams (`apps/worker/src/index.ts` → `checkSite`). The browser
fetches only the pre-aggregated KV snapshot (`apps/web/src/lib/data.ts`). Badges
are shields.io JSON contracts (`packages/core/src/badge.ts`), never generated
images. This is the primary flaw StatusBeam fixes versus upptime — do NOT
introduce client-side calls to monitored services or external status APIs.

**Config is a single YAML validated only by core.** One `status.config.yml` is
uploaded to KV key `config`; both Worker and Web parse it through the same
`parseConfig` (`packages/core/src/config.ts`). Do NOT parse or reshape config
outside core. Slugs are charset-constrained at parse time so they are
Cache-Tag-safe.

**Cache-Tag definitions are shared and must not drift.** The emit side (web
headers) and purge side (worker) both import `cacheTags` / `STATUS_PAGE_TAG` from
`packages/core/src/cache.ts`. Do NOT hardcode a cache tag on either side.

**Builds are configuration-independent.** Nothing about a user's services is
compiled into the bundle — the Worker reads config from KV at runtime and the
page falls back to bundled sample data until KV is populated. This is what makes
package-based distribution possible (ADR-0002). Do NOT bake config into the build.

**Each locale is a distinct URL** (`/en/`, `/ja/`, `/ko/`, `/zh/`) so the edge
cache never fragments on `Accept-Language`. Bare `/` negotiation
(`apps/web/src/middleware.ts`) redirects with `private, no-store`.

**Worker writes, Web reads the same D1/KV.** The two Workers share identical D1
(`DB`) and KV (`STATUS_KV`) bindings (`apps/worker/wrangler.jsonc` vs
`apps/web/wrangler.jsonc`). Web must remain a read-only consumer of the snapshot.

## Cross-Cutting Concerns

**Error handling**: check functions never throw on the request path — a network
failure returns a `down` `CheckResult` (`code: 0`); a payload/validation failure
preserves the real HTTP code (`packages/core/src/check.ts`). External payloads
(Statuspage) are validated at the boundary with `zod.safeParse`. Web read paths
degrade rather than fail the render: locale/incident/badge helpers fall back on
malformed KV. `notify` and `cache` failures are logged, never thrown, so one bad
target cannot wedge a cron run.

**Logging**: `console.warn` / `console.error` only, always with context. URLs are
redacted to origin before logging (`apps/worker/src/notify.ts`). Steady-state
misconfiguration warns once per isolate (`apps/web/src/lib/data.ts`).

**Testing**: `bun test`. Unit tests live co-located in `packages/core/src/*.test.ts`
(8 files, ~110 cases). Coverage config in `bunfig.toml` (`text` + `lcov` →
`coverage/`). CI runs `bun run test --coverage --reporter=junit`
(`.github/workflows/ci.yml`). Coverage gate scoped to `packages/` in
`sonar-project.properties` (`apps/**`, `components/ui/**`, `scripts/**` excluded).

**Configuration / env**: `status.config.yml` (committed demo) +
`status.config.example.yml` (documented fields), parsed only through core. Worker
env typed in `apps/worker/src/env.ts`; secrets `CF_API_TOKEN` / `CF_ZONE_ID` set
via `wrangler secret`. `scripts/apply-config.ts` idempotently splices account IDs,
cron, and custom domain into both `wrangler.jsonc` files during `bun run setup`.

**Supply chain / CI**: SHA-pinned GitHub Actions, zizmor workflow lint, codecov
(patch target 80%, OIDC tokenless), SonarCloud (`pleaseai_statusbeam`).
`deploy.yml` is manual-dispatch with per-step secret scoping. release-please
drives versioning + CHANGELOG.

## Quality Notes

**Well-tested (safe to refactor)**: all of `packages/core` — `check.ts` (26),
`config.ts` (18), `badge.ts` (15), `i18n.ts` (14), `incidents.ts` (14),
`types.ts` (14), `notify.ts` (5), `cache.ts` (4). These pure functions carry the
domain logic and are the safest place to change behavior.

**Fragile (needs care — no unit tests)**:

- `apps/worker/src/*` — `index.ts` (cron orchestration, D1→snapshot aggregation
  SQL, change detection), `cache.ts`, `notify.ts` contain real glue logic with
  **zero unit tests**; only the core helpers they call are tested.
- `apps/web/src/*` — `lib/data.ts`, `lib/page.ts`, `lib/api.ts`, `middleware.ts`,
  and components are untested by design (excluded from coverage; validated via
  `astro check` + build).
- `scripts/apply-config.ts` — non-trivial regex string-splicing, no tests.

**Highest-risk untested surfaces**: the D1→snapshot aggregation and
change-detection in `apps/worker/src/index.ts`, and the config-file editing in
`scripts/apply-config.ts`.

**Technical debt**: notifications and cache purge are inline REST calls with no
Queue binding yet — deliberate, with the Cloudflare Queues upgrade path documented
in `apps/worker/wrangler.jsonc`. TCP/SSL checks are accepted by the config schema
but not yet implemented (see the roadmap in `README.md`).

---

_Last updated: 2026-07-08_

_Key ADRs:_

- _[ADR-0001](docs/adr/0001-tech-stack.md): Astro + shadcn/ui, Cloudflare Cron/D1/KV/Queues, edge-cache-on-change — and the upptime failure modes that drove them._
- _[ADR-0002](docs/adr/0002-package-based-distribution.md): ship the app as a versioned package/CLI rather than a fork, because builds are configuration-independent._
