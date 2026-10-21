# ADR-0001: Tech stack

## Status

Accepted

**Deciders:** StatusBeam maintainers

## Date

2026-07-07

> **Note:** This ADR's tech-stack decision stands. Its *distribution* framing —
> upptime's "fork a repo, done" as the baseline — has been revisited by
> [ADR-0002](0002-package-based-distribution.md): StatusBeam now ships as published
> packages consumed as a versioned dependency, not as a repository to fork. Read the
> "fork" references below as the historical starting point, not the current model.

## Context

StatusBeam is an open-source status page generator, conceived as a modern
take on [upptime](https://github.com/upptime/upptime). We need to choose a
**frontend framework**, a **check/scheduling mechanism**, a **data store**, and a
**deploy target**. Two hard requirements shaped the decision:

1. **shadcn/ui** for the component layer (copy-in-repo, forkable — a good fit for OSS).
2. **CDN/edge deployment** to Cloudflare and/or Vercel, so the status page survives
   the very outages it reports.

We also studied upptime's architecture to learn from its failure modes (see the
"Learnings from upptime" section).

## Decision

| Concern | Decision |
|---|---|
| Frontend framework | **Astro** |
| UI components | **shadcn/ui** (React islands) + Tailwind CSS |
| Check scheduler | **Cloudflare Cron Triggers** (Worker) |
| Data store | **Cloudflare D1** (SQLite) + **KV** |
| Edge cache | **Cloudflare Workers Cache** (tag-purged on status change) |
| Notifications | Cloudflare **Workers + Queues** |
| Deploy target | **Cloudflare** primary, **Vercel** supported |

## Frontend: Astro over SvelteKit and TanStack Start

A status page is read-heavy, prerendered from known data, with only a few interactive
widgets (charts, time-range filters). That profile rewards **static-first + selective
interactivity**, not a full client-side app framework.

| Criterion | Astro | SvelteKit | TanStack Start |
|---|---|---|---|
| SSG / static-first | ★ core identity, ~0 KB JS default | ★ mature (`adapter-static`) | newest, retrofitted onto full-React |
| Client payload | lowest (islands) | small (Svelte compiler) | heaviest (full React hydration, no islands) |
| shadcn/ui | **native** via React islands | shadcn-**svelte** (unofficial port only) | **native** (canonical React) |
| Cloudflare deploy | **first-party** (Cloudflare acquired Astro, Jan 2026; `workerd` dev/prod parity) | first-party adapter | works, least-proven edge story |
| Maturity (2026) | mature; Astro 7 | most mature/stable | v1.0 since Mar 2026, youngest |

**Why Astro wins for us:**

- **shadcn/ui is a hard requirement**, and shadcn is React/Tailwind. Astro runs the
  *canonical* React shadcn/ui via islands — no unofficial port. SvelteKit can only use
  the community `shadcn-svelte` port; that alone disqualifies it given requirement #1.
- **Static-first matches the data shape.** Uptime/incident data is known at render
  time; Astro ships ~0 KB JS except for the interactive islands (charts, filters).
- **Cloudflare is now Astro's home.** With the check and notify layers already on
  Cloudflare Workers, keeping the display layer on Astro unifies everything on one
  platform (`workerd`), with dev/prod parity.

**Why not TanStack Start:** native React shadcn is nice, but it has no islands (full
React hydration = heaviest payload), and its SSG + edge-deploy story is the youngest
and least battle-tested. It is over-powered for a read-only prerendered page; its
strengths (type-safe routing, server functions) are wasted here.

**Note on the incumbent:** upptime does *not* use SvelteKit — it uses **Svelte 3 +
Sapper**, both end-of-life. Any of the three candidates is a modernization; the choice
is about the best fit, not merely "newer than upptime."

## Scheduler & store: Cloudflare Cron Worker + D1/KV over GitHub Actions + git

upptime is serverless via GitHub Actions (cron), git commits (database), and Issues
(incidents). Elegant, but with real limits (below). We instead run checks in a
**Cloudflare Cron Worker** and store results in **D1 + KV**:

- **Reliable scheduling.** Cloudflare Cron Triggers fire on time; GitHub Actions cron
  is best-effort and routinely slips 15–60 min under load.
- **A store built for the query.** D1 (SQLite) serves time-series and incident history
  directly; KV holds the current snapshot and an edge cache. No walking unbounded git
  history through a rate-limited API.
- **Real-time notifications.** A status flip in the Worker enqueues a notification
  event immediately (Slack/webhook/email/RSS), instead of waiting on a commit +
  separate redeploy.
- **One platform.** Checks, storage, notifications, and the Astro page all live on
  Cloudflare — simpler ops, and the notify layer the maintainers want next drops in
  naturally.

## Edge cache: Cloudflare Workers Cache

The Astro display Worker is fronted by
[Workers Cache](https://blog.cloudflare.com/workers-cache/) — a tiered edge cache in
front of a Worker entrypoint, enabled with one Wrangler line
(`"cache": { "enabled": true }`) and standard `Cache-Control` headers. It matters here
for three reasons:

- **Reads don't hit D1 on every view.** Rendered pages and badge JSON set
  `Cache-Control` + `stale-while-revalidate`; cache hits skip the Worker (and its D1
  read) entirely, and **request collapsing** deduplicates concurrent misses. This
  hardens the "no client rate limits" property against traffic spikes — a popular
  page no longer means a read amplification on the store.
- **Freshness without TTL lag.** On a status change, the check Worker calls
  `ctx.cache.purge()` with a tag to invalidate the affected page/badge. Updates are
  near-instant rather than bound to a TTL — directly fixing upptime's cron → commit →
  separate-redeploy pipeline latency.
- **Native Astro support.** Astro supports Workers Cache first-class (per Cloudflare's
  announcement), so this is a configuration concern, not a custom caching layer — another
  point reinforcing the Astro choice. **Astro 7** (released 2026, now our pinned version)
  adds a stable `Astro.cache` route-caching API and an experimental `cacheCloudflare()`
  provider for Workers Cache; we use `Cache-Control` headers today and adopt `Astro.cache`
  as it stabilizes.

This narrows KV's role to the **current snapshot** (the check Worker's fast state);
edge caching of rendered output is Workers Cache's job, not KV's.

Trade-off: this requires a Cloudflare account and some resource provisioning (D1, KV,
Queues), versus upptime's "fork a repo, done." We accept that cost for correctness and
scale, and will keep configuration to a single `status.config.yml`.

## Deploy target

**Cloudflare is primary** (the whole stack lives there). **Vercel is supported** for
the display layer via Astro's Vercel adapter, for teams already on Vercel — though the
check/store/notify layers still assume Cloudflare (or an equivalent) underneath.

## Learnings from upptime (what we deliberately fix)

1. **Client-side GitHub API rate limits** — upptime's page fetches data from the
   *browser* (unauthenticated, 60 req/h/IP) and breaks on popular pages. → We render at
   the edge from our own store; the browser never calls a third-party API.
2. **Unreliable cron** — GitHub Actions cron slips badly. → Cloudflare Cron Triggers.
3. **Git-as-database doesn't scale** — every status change is a commit, and uptime math
   paginates the commits API. → D1 time-series.
4. **EOL frontend** — Svelte 3 + Sapper. → Astro + shadcn/ui.
5. **Pipeline latency** — cron → commit → separate daily redeploy. → Edge render reads
   live from D1/KV; on a status change the check Worker purges the Workers Cache by tag,
   so the page updates near-instantly; notifications fire on the same flip.

## What we keep from upptime

- **Config-as-a-single-YAML** — one `status.config.yml` is the only thing a user edits.
- **shields.io-compatible badge JSON** + a **public JSON API**.
- **Static/edge hosting** decoupled from the monitored infrastructure.
- The **incident lifecycle** model (Investigating → Identified → Monitoring → Resolved).

## Consequences

- The project is a small monorepo: an Astro app (display), a Cron Worker (checks +
  notifications), and shared TypeScript packages (config schema, status logic, types).
- Contributors need a Cloudflare account with D1/KV/Queues to run the full stack
  locally; the Astro app alone can run against fixture data.
- Requirement #1 (shadcn/ui) makes React the island runtime even though the app is
  Astro — acceptable, since islands are scoped to the few interactive widgets.
