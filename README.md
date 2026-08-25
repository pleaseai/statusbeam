# StatusBeam

[![CI](https://github.com/pleaseai/statusbeam/actions/workflows/ci.yml/badge.svg)](https://github.com/pleaseai/statusbeam/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=pleaseai_statusbeam&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=pleaseai_statusbeam)
[![codecov](https://codecov.io/gh/pleaseai/statusbeam/graph/badge.svg)](https://codecov.io/gh/pleaseai/statusbeam)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Reviewed by Greptile](https://img.shields.io/badge/code%20review-Greptile-2ea44f)](https://www.greptile.com/open-source)
[![Reviewed by cubic](https://img.shields.io/badge/code%20review-cubic-14b8a6)](https://www.cubic.dev)
[![Live demo](https://img.shields.io/badge/live%20demo-demo.statusbeam.dev-brightgreen)](https://demo.statusbeam.dev)
[![Deploy on Cloudflare](https://img.shields.io/badge/deploy%20on-Cloudflare-F38020?logo=cloudflare&logoColor=white)](./DEPLOYMENT.md)

> An open-source, CDN-native **status page** generator — a modern take on [upptime](https://github.com/upptime/upptime).

🔗 **Live demo:** [demo.statusbeam.dev](https://demo.statusbeam.dev) — a StatusBeam instance monitoring a few public services, running on Cloudflare.

StatusBeam monitors your services, records their uptime as durable time-series
data, and publishes a fast, good-looking status page to the edge. It keeps the parts
of upptime that people love — config-as-YAML, zero servers to babysit, badges, a
public JSON API — while fixing upptime's biggest structural weaknesses:

- **No client-side rate limits.** upptime's page calls the GitHub API *from the
  visitor's browser* (unauthenticated, 60 req/h/IP), so popular pages break with a
  "rate limit exceeded" screen. StatusBeam renders every byte at the edge from
  its own store — the browser never talks to a third-party API.
- **Reliable scheduling.** upptime rides GitHub Actions cron, which is best-effort
  (a "every 5 min" job can slip to 15–60 min). StatusBeam uses **Cloudflare
  Cron Triggers**, which fire on time.
- **A store that scales.** upptime treats git commit history as its database and
  walks it through a rate-limited API. StatusBeam uses **Cloudflare D1 + KV**,
  purpose-built for time-series reads.
- **A current, maintained frontend.** upptime's page is built on **Svelte 3 + Sapper**,
  both end-of-life. StatusBeam is **Astro + shadcn/ui**.

---

## Status

🚧 **Active development.** The core pipeline is live end-to-end — HTTP checks on
Cloudflare Cron write to D1/KV, the Astro page renders 90-day uptime bars, response-time
charts, and an incident timeline at the edge, and status changes fan out to Slack/webhooks
while purging the edge cache. A [live demo](https://demo.statusbeam.dev) runs on
Cloudflare. TCP/SSL checks, a public API + badges, and more notification channels are
next — see the [Roadmap](#roadmap).

---

## How it works

StatusBeam is deliberately split into three independent layers. Each can be
understood, deployed, and replaced on its own.

```
        ┌──────────────────────────────────────────────────────────────┐
        │  1. CHECK LAYER — Cloudflare Cron Worker                       │
        │     • Cron Triggers ping every configured service on schedule  │
        │     • Derives up / degraded / down from status + response time │
        │     • Writes time-series to D1, current snapshot to KV         │
        │     • On a status change: enqueue a notification event, and    │
        │       purge the page/badge cache by tag (ctx.cache.purge)      │
        └──────────┬────────────────┬─────────────────────┬────────────-┘
                   │ writes         │ enqueues            │ purges on change
                   ▼                ▼                     │
        ┌───────────────────┐  ┌──────────────────────┐   │
        │ D1 (time-series,  │  │ 2. NOTIFY LAYER —    │   │
        │     incidents)    │  │    Queue consumer    │   │
        │ KV (current       │  │  • Email, Slack,     │   │
        │     snapshot)     │  │    webhook, RSS/Atom │   │
        └─────────┬─────────┘  └──────────────────────┘   │
                  │ reads at the edge                      │
                  ▼                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  3. DISPLAY LAYER — Astro site on Cloudflare                   │
        │     • Renders the page at the edge from D1/KV (no browser →    │
        │       third-party API calls, so no client rate limits)         │
        │     • Fronted by Workers Cache (tiered edge cache): renders    │
        │       set Cache-Control + stale-while-revalidate, hits skip    │
        │       the Worker + D1, concurrent requests collapse; the check │
        │       layer purges by tag on change, so updates are near-      │
        │       instant, not TTL-bound                                   │
        │     • shadcn/ui via React islands for the interactive bits     │
        │       (charts, time-range filters); everything else ships 0 JS │
        │     • Emits shields.io-compatible badge JSON + a public API    │
        └──────────────────────────────────────────────────────────────┘
```

Because the check and display layers live on Cloudflare — **not** on the
infrastructure being monitored — your status page stays up even when your own
services are down. That resilience is the whole point of a status page.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | [Astro 7](https://astro.build/blog/astro-7/) | Static-first (ideal for a mostly-read page), ~0 KB JS by default, a Cloudflare first-party framework (acquired Jan 2026) with `workerd` dev/prod parity, a Rust compiler (15–61% faster builds), and a stable **`Astro.cache` route-caching API** plus an experimental `cacheCloudflare()` provider for [Workers Cache](https://blog.cloudflare.com/workers-cache/). |
| **UI components** | [shadcn/ui](https://ui.shadcn.com) (React islands) + Tailwind CSS | Copy-in-your-repo components you own and can fork — perfect for OSS. Used natively via Astro's React islands; hydrated only where interactivity is needed. |
| **Charts** | shadcn/ui charts (Recharts) | Response-time graphs, themed and dark-mode-ready out of the box. |
| **Check scheduler** | Cloudflare **Cron Triggers** (Worker) | On-time execution, unlike GitHub Actions cron. |
| **Data store** | Cloudflare **D1** (SQLite) + **KV** | D1 for time-series & incident history; KV for the current snapshot. |
| **Edge cache** | Cloudflare **[Workers Cache](https://blog.cloudflare.com/workers-cache/)** | Tiered cache in front of the Astro Worker: `Cache-Control` + `stale-while-revalidate`, request collapsing, and **tag-based purge on status change** — near-instant updates without hammering D1. Today via `Cache-Control` headers; Astro 7's `Astro.cache` / `cacheCloudflare()` is the forward path. |
| **Notifications** | Cloudflare Workers + Queues | Email / Slack / webhook / RSS on status change, decoupled from the UI. |
| **Deploy target** | **Cloudflare** (primary) · Vercel (supported) | Astro adapters target both; Cloudflare is the native, batteries-included path. |
| **Tooling** | Bun · Wrangler · TypeScript | Bun for install/scripts; Wrangler for Worker + D1 + KV. |

The full rationale — including why Astro over SvelteKit and TanStack Start, and why
a Cron Worker over GitHub Actions — is in
[`docs/adr/0001-tech-stack.md`](docs/adr/0001-tech-stack.md).

---

## Design

The UI follows the information architecture proven by
[Statuspage.io](https://www.atlassian.com/software/statuspage) and the modern,
static-first aesthetic of [Instatus](https://instatus.com):

- **Overall-status banner** — one calm, unambiguous line ("All Systems Operational")
  in a single color that rolls up the worst component state.
- **Component rows** — one per service, grouped and collapsible, each with a status
  pill: Operational / Degraded / Partial Outage / Major Outage / Maintenance.
- **90-day uptime bars** — the signature timeline: one colored bar per day, hover for
  date + uptime % + linked incidents, gray for no-data days. Adaptive intervals
  (Instatus-style) let the same component render other windows.
- **Incident timeline** — a reverse-chronological, date-grouped feed; each incident
  threads timestamped updates through the
  Investigating → Identified → Monitoring → Resolved lifecycle. Scheduled maintenance
  is a distinct, forward-looking entry.
- **One severity token system** — five states as CSS variables (light + dark, OKLCH),
  driving the banner, pills, and bars from a single source of truth. Dark mode ships
  by default. Color is paired with icon + text for accessibility.

---

## Project layout

A Bun-workspaces monorepo. The three runtime layers map to three workspaces, with
the domain logic shared in `core`:

```
statusbeam/
├── apps/
│   ├── web/       # Astro status page (Cloudflare adapter + Workers Cache)
│   └── worker/    # Cron Worker: checks + notifications (D1/KV, schema.sql)
├── packages/
│   └── core/      # shared config schema (zod), types, status derivation
├── status.config.example.yml
├── mise.toml      # pinned toolchain (node, bun)
└── orca.yaml      # worktree setup
```

Local development:

```bash
mise install        # pinned node + bun
bun install         # install workspaces
bun run test        # core unit tests (bun:test)
bun run dev         # Astro dev server (renders sample data without bindings)
```

## Configuration

A single YAML file is the only thing you edit — the same idea as upptime's
`.upptimerc.yml`. Copy [`status.config.example.yml`](./status.config.example.yml) to
`status.config.yml`:

```yaml
# status.config.yml
name: Acme Status
sites:
  - name: Website
    url: https://example.com
    check: http # http | tcp | ssl | statuspage | incidentio | sentry | aigateway
    expectedStatusCodes: [200]
    maxResponseTime: 2000 # ms → "degraded" above this
  - name: API
    url: https://api.example.com/health
    check: http
  - name: Claude # mirror an Atlassian Statuspage (status.claude.com, *.statuspage.io, …)
    url: https://status.claude.com # base URL; /api/v2/summary.json is appended for you
    check: statuspage
  - name: Claude API # or track one service on that page by component name/id
    url: https://status.claude.com
    check: statuspage
    component: Claude API (api.anthropic.com)
  - name: OpenAI # incident.io status pages read the same way (Statuspage-compatible)
    url: https://status.openai.com
    check: incidentio
notifications: # all optional; keep the real Slack URL (a secret) in your KV config
  slack:
    webhookUrl: https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
  webhooks:
    - url: https://example.com/status-hook
theme:
  logoUrl: /logo.svg
  darkMode: true
  locale: en # fallback UI language: en | zh | ja | ko (default en)
```

### Check types

Each site sets a `check` kind:

| `check`      | What it does                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `http`       | Fetches `url`; `up`/`degraded`/`down` from the status code and response time.|
| `tcp`        | Reserved — currently falls through to `http` ([roadmap](#roadmap)).          |
| `ssl`        | Reserved — currently falls through to `http` ([roadmap](#roadmap)).          |
| `statuspage` | Mirrors an Atlassian Statuspage's own verdict. See the [Statuspage adapter guide](./docs/adapters/statuspage.md).|
| `incidentio` | Mirrors an [incident.io](https://incident.io) status page (Statuspage-compatible). See the [incident.io adapter guide](./docs/adapters/incidentio.md).|
| `sentry`     | Mirrors a [Sentry Uptime](https://docs.sentry.io/product/uptime-monitoring/) monitor via issue webhook (real-time) + optional poll backstop. See the [Sentry adapter guide](./docs/adapters/sentry.md).|
| `aigateway`  | Reads a model endpoint's published health from the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) or [OpenRouter](https://openrouter.ai/docs). See the [AI Gateway adapter guide](./docs/adapters/aigateway.md).|

The **Statuspage adapter** reads a vendor's `/api/v2/summary.json` (Claude,
Vercel, `*.statuspage.io`, …) and maps their overall indicator — or a single
component you name — to a status. Full reference, status-mapping tables, and
edge behavior: [`docs/adapters/statuspage.md`](./docs/adapters/statuspage.md).

The **incident.io adapter** reads the same Statuspage-compatible
`/api/v2/summary.json` that incident.io status pages (`status.openai.com`,
`status.incident.io`, …) serve — so `incidentio` and `statuspage` behave
identically; use whichever names your vendor:
[`docs/adapters/incidentio.md`](./docs/adapters/incidentio.md).

The **Sentry adapter** presents a [Sentry Uptime](https://docs.sentry.io/product/uptime-monitoring/)
monitor on your status page. Sentry runs the checks; StatusBeam ingests the
verdict in real time from a Sentry issue webhook (`POST /webhooks/sentry/:slug`),
with an optional cron poll of Sentry's Issues API as the backstop. Binary
(`up`/`down`). Setup, status mapping, and the webhook-only vs. poll modes:
[`docs/adapters/sentry.md`](./docs/adapters/sentry.md).

The **AI Gateway adapter** puts a model's health on your status page by reading
what the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) or
[OpenRouter](https://openrouter.ai/docs) already publishes about the providers
serving it — uptime and latency from their own production traffic. It sends no
probe requests to the model, so it spends **no tokens** and needs no API key.
Grade the whole model (best endpoint wins, since the gateway routes around a
failing provider) or one provider endpoint by name. Note the two gateways
aggregate over different windows, and OpenRouter currently publishes no latency:
[`docs/adapters/aigateway.md`](./docs/adapters/aigateway.md).

### Internationalization

The status page UI is translated into English (`en`), Simplified Chinese (`zh`),
Japanese (`ja`), and Korean (`ko`); dates and relative times localize
automatically.

Each language is a URL prefix — `/en/`, `/ja/`, `/ko/`, `/zh/` — so every
language is cached independently at the edge (no cache fragmentation). Visiting
the bare `/` redirects to the visitor's language, chosen in this order:

1. their remembered choice (a `locale` cookie, set when they pick a language),
2. their browser's `Accept-Language`,
3. the deployment's `theme.locale` (used only when the above don't match a
   supported language),
4. English.

A language switcher in the footer lets visitors change and remember their
choice.

---

## Badges & public API

Every deployment exposes a small public JSON surface at `/api/*`, served from the
same edge-cached KV snapshot as the status page (and purged on the same status
changes, so badges never lag the page).

### Badges

The badge routes speak the [shields.io endpoint](https://shields.io/badges/endpoint-badge)
protocol — point shields.io at one and it renders the SVG; StatusBeam only
emits the JSON. Replace `<origin>` with your status page's URL and `<slug>` with
a component's slug (the `slug` from `status.config.yml`, or the slugified name):

| Badge          | Endpoint                                             |
| -------------- | ---------------------------------------------------- |
| Overall status | `/api/badge.json`                                    |
| Site status    | `/api/badge/<slug>.json`                             |
| Site uptime    | `/api/badge/<slug>/uptime.json` (`?period=day\|week\|month`, default `month`) |
| Response time  | `/api/badge/<slug>/response-time.json`               |

```markdown
![status](https://img.shields.io/endpoint?url=https://status.example.com/api/badge.json)
![uptime](https://img.shields.io/endpoint?url=https://status.example.com/api/badge/api/uptime.json)
```

Colors are derived from severity (green → operational, yellow → degraded, red →
down), uptime ratio, and response time. Add any shields.io query (`?style=flat-square`,
`?label=API`, `?logo=cloudflare`) to restyle the rendered badge.

### Status API

- `GET /api/status.json` — the whole dashboard: rolled-up `status` plus a lean
  per-site summary (status, response time, day/week/month uptime).
- `GET /api/status/<slug>.json` — one site's full record, including the 90-day
  history and response-time samples.

Both send `Access-Control-Allow-Origin: *`, so a browser can fetch them directly.

---

## Deployment

StatusBeam deploys to any Cloudflare account (Workers + D1 + KV + Pages). Vercel
is also supported for the display layer via Astro's Vercel adapter.

**You deploy StatusBeam as a package, not a fork** ([ADR-0002](docs/adr/0002-package-based-distribution.md)):
your repo holds only your config, and the app is a versioned dependency. Scaffold a thin
project, then let the `statusbeam` CLI provision D1 + KV, wire your custom domain and cron,
apply the schema, upload `status.config.yml`, and deploy both Workers — idempotent, safe to
re-run.

```bash
bunx create-statusbeam my-status   # or "Use this template" on statusbeam-template
cd my-status
bunx wrangler login                # or export CLOUDFLARE_API_TOKEN
bun install
bunx statusbeam setup              # provisions, configures, deploys (--skip-deploy to stop before deploy)
```

Upgrading is `bunx statusbeam update` — no upstream merge. Prefer to modify the app source?
You can still fork and deploy the monorepo directly; see the appendix in
[DEPLOYMENT.md](./DEPLOYMENT.md).

### Instant cache invalidation (optional)

By default the page is edge-cached for `s-maxage=60`, so a status change shows up
within a minute. For **near-instant** updates, the check Worker purges the edge
cache by [Cache-Tag](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)
the moment a status flips. The page already emits a matching `Cache-Tag` response
header (`status-page` + one `status-site-<slug>` per component); you just provide
the Worker two secrets (purge-by-tag is [available on all Cloudflare plans](https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/) since April 2025):

```bash
bunx wrangler secret put CF_API_TOKEN   # API token with the "Cache Purge" permission
bunx wrangler secret put CF_ZONE_ID     # the zone serving your status page
```

When these are unset the purge is skipped (logged, not fatal) and the page simply
refreshes on its 60s TTL.

**Full runbook** — the CLI, provisioning, config, secrets, CI deploy, and the
fork-from-source appendix — is in **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

---

## Roadmap

**Shipped**

- [x] **Check layer** — Cron Worker: HTTP checks, D1 time-series schema, KV snapshot.
- [x] **Display layer** — Astro site, shadcn/ui component set, severity token system.
- [x] **Uptime bars & charts** — 90-day adaptive timeline, per-component response-time graphs.
- [x] **Incidents** — lifecycle model (Investigating → Identified → Monitoring → Resolved) + timeline UI.
- [x] **Notify layer (part 1)** — Slack + generic webhook on status change, decoupled via Queues.
- [x] **Edge cache** — `Cache-Tag` emit + purge-on-change loop between the check and display layers.
- [x] **Badges & public API** — [shields.io endpoint](#badges--public-api) badges + JSON status API, edge-cached.
- [x] **Statuspage adapter** — mirror any Atlassian Statuspage by page or component ([guide](./docs/adapters/statuspage.md)).
- [x] **incident.io adapter** — mirror any incident.io status page by page or component ([guide](./docs/adapters/incidentio.md)).
- [x] **Statuspage webhooks** — real-time ingest via `POST /webhooks/statuspage/:slug`, cron as the backstop ([guide](./docs/adapters/statuspage.md#real-time-updates-via-webhooks)).
- [x] **Sentry Uptime adapter** — mirror a [Sentry Uptime](https://docs.sentry.io/product/uptime-monitoring/) monitor via issue webhook (`POST /webhooks/sentry/:slug`) + optional Issues-API poll backstop ([guide](./docs/adapters/sentry.md)).
- [x] **AI Gateway adapter** — track a model endpoint's published health on the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) or [OpenRouter](https://openrouter.ai/docs), token-free ([guide](./docs/adapters/aigateway.md)).

**In progress / planned**

- [ ] **TCP/SSL checks** — extend the Cron Worker beyond HTTP (config + schema already accept them).
- [ ] **Scheduled maintenance** — distinct, forward-looking incident entries.
- [ ] **Notify layer (part 2)** — email + RSS/Atom feeds.
- [ ] **Migration guide** — importing an existing `.upptimerc.yml`.
- [ ] **Vercel adapter path** — documented alternative to Cloudflare.

---

## Prior art & inspiration

- [upptime/upptime](https://github.com/upptime/upptime) — the serverless-monitoring
  idea this project builds on.
- [Statuspage.io](https://www.atlassian.com/software/statuspage) — the reference
  information architecture.
- [Instatus](https://instatus.com) — static-first delivery and modern design.
- [statping/statping](https://github.com/statping/statping) — a self-hosted,
  single-binary status server (Go) with its own monitoring engine, notifiers,
  and mobile app.
- [OpenStatus](https://www.openstatus.dev) — open-source synthetic monitoring and
  status pages, with a globally distributed checker for latency-aware probing.
- [CachetHQ/Cachet](https://cachethq.io) — a long-standing open-source status page
  system (PHP/Laravel) centered on incident and component management.

---

## Code review

Pull requests to StatusBeam are reviewed by two AI code reviewers, both free for
open source:

- **[Greptile](https://www.greptile.com/open-source)** — free for non-commercial
  MIT/Apache projects under its OSS program.
- **[cubic](https://www.cubic.dev)** — free for public repositories.

[![Reviewed by Greptile](https://img.shields.io/badge/code%20review-Greptile-2ea44f)](https://www.greptile.com/open-source)
[![Reviewed by cubic](https://img.shields.io/badge/code%20review-cubic-14b8a6)](https://www.cubic.dev)

---

## License

MIT
