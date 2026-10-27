# Tech Stack — StatusBeam

## Overview

Bun-managed **Turborepo monorepo** targeting Cloudflare's edge platform.
TypeScript throughout. Workspaces under `apps/*` and `packages/*`.

## Repository layout

| Workspace | Package | Role |
|-----------|---------|------|
| `apps/web` | `@statusbeam/web` | Display layer — Astro site rendered/deployed on Cloudflare |
| `apps/worker` | `@statusbeam/worker` | Check + notify layer — Cloudflare Cron Worker |
| `packages/core` | `@statusbeam/core` | Shared config parsing, schema, domain types |

## Toolchain

- **Runtime / package manager**: [Bun](https://bun.sh) `1.3.14`, pinned via
  `package.json` `packageManager`. `mise.toml` installs Bun (currently at
  `latest`) and provides tasks. Test runner: `bun test`.
- **Monorepo orchestration**: [Turborepo](https://turborepo.com) `^2.10`
  (`turbo run dev | build | typecheck`).
- **Language**: TypeScript `^6.0`.
- **Lint**: ESLint `^10` with `@pleaseai/eslint-config`.
- **Version manager**: mise (`mise.toml`).

## apps/web — Display layer

- **Framework**: Astro `^7` with the Cloudflare adapter (`@astrojs/cloudflare`).
- **UI**: React islands (`@astrojs/react`), `@base-ui/react`, shadcn/ui-style
  components (`class-variance-authority`, `clsx`, `tailwind-merge`,
  `tw-animate-css`), `lucide-react` icons.
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite`).
- **Charts**: recharts.
- **Deploy**: wrangler `^4`.

## apps/worker — Check + notify layer

- **Platform**: Cloudflare Worker (`@cloudflare/workers-types`), driven by
  **Cron Triggers**.
- **Deploy**: wrangler `^4`.
- Depends on `@statusbeam/core` for config + schema.

## packages/core — Shared domain

- **Validation**: Zod `^4.4`.
- **Config parsing**: `yaml`.
- Pure, dependency-light shared library consumed by both apps.

## EmDash distribution

[EmDash](https://github.com/emdash-cms) is an Astro-based CMS (ADR-0005, superseding ADR-0004).
StatusBeam ships two packages for it:

- **`packages/emdash-plugin`** (`@statusbeam/emdash-plugin`) — one native EmDash plugin (id
  `statusbeam`, ADR-0005): the check engine, the React admin pages (status overview, monitor
  editor, dashboard widget), and the "Status" Portable Text block. Sites register it with
  `plugins: [statusbeam()]`; no sandbox runner. Ships `.ts`/`.tsx`/`.astro` source with no build
  step. Peers: `emdash ~1.3.1` (pinned because header-time probing relies on the undocumented
  `createUnrestrictedHttpAccess` export), `astro`, `react`, `@cloudflare/kumo`,
  `@emdash-cms/admin`.
- **`packages/emdash-ui`** (`@statusbeam/emdash-ui`) — Astro status components and a client that
  read the public JSON of a standalone deployment or the plugin. Library only (`.`, `./client`),
  no plugin entry; source, no build step.
- **Tests**: the plugin's native host tests run it on `emdash/internal/plugin-test-runtime` under
  bun (`bun run --cwd packages/emdash-plugin test:host`), and its admin component tests run on
  happy-dom (`test:admin`). Neither is part of the root `bun test`; CI and publish run both.
- **`apps/emdash-demo`** is a private spike and reference site outside the root
  workspace, with its own lockfile.

## Data & edge services (Cloudflare)

- **D1** (SQLite) — durable time-series of check results.
- **KV** — current-status snapshot for fast reads.
- **Queues** _(planned)_ — would decouple notification fan-out from checks; not
  yet implemented (dispatch is currently synchronous inline `fetch` via
  `ctx.waitUntil`).
- **Cron Triggers** — reliable scheduling for the check worker.
- **Cache-Tag / edge cache** — page & badge caching with purge-on-change.

## Quality & CI

- **CI**: GitHub Actions (`.github/workflows/ci.yml`).
- **Coverage**: Codecov (`codecov.yml`).
- **Static analysis**: SonarCloud (`sonar-project.properties`,
  project `pleaseai_statusbeam`).
- **Releases**: release-please (`release-please-config.json`,
  `.release-please-manifest.json`) — Conventional-Commits-driven versioning.
- **External AI review**: Greptile, cubic (per README badges).

## Common commands

```bash
bun install              # install workspace deps
bun run dev              # turbo run dev (all apps)
bun run build            # turbo run build
bun run typecheck        # turbo run typecheck
bun test                 # run tests
bun run lint             # eslint .
bun run deploy           # deploy worker + web to Cloudflare
```
