# ADR-0002: Package-based distribution

## Status

Accepted

**Deciders:** StatusBeam maintainers

## Date

2026-07-08

## Context

Today a user stands up their own status page by **forking** `pleaseai/statusbeam`,
editing `status.config.yml` + `wrangler.jsonc` in the fork, and deploying with
`bun run setup` / the `deploy.yml` workflow (see `DEPLOYMENT.md`). This is the model
[upptime](https://github.com/upptime/upptime) popularized, and ADR-0001 accepted its
"fork a repo, done" ergonomics as the baseline.

The fork model has one structural problem: **updates.** A fork vendors the entire app
source (`apps/web`, `apps/worker`, `packages/core`). Pulling a new release means merging
upstream into a fork whose `wrangler.jsonc` (resource IDs, custom domain, cron) and
`status.config.yml` have diverged — a recurring merge-conflict tax on exactly the files
the user owns. Users fall behind on fixes because upgrading is painful.

A fork carries four kinds of content, but only three are actually user-specific:

| In the fork today | User-specific? |
|---|---|
| App source (`apps/web`, `apps/worker`, `packages/core`) | **No** — byte-identical for everyone |
| `status.config.yml` (service list) | Yes |
| `wrangler.jsonc` (resource IDs, domain, cron) | Yes |
| `.github/workflows/deploy.yml` + secrets/variables | Yes |

The decisive property: **the builds are configuration-independent.** The worker reads
`config` from KV at runtime and the page falls back to bundled sample data until KV is
populated (`DEPLOYMENT.md` §5). Nothing about a user's services is compiled into the
bundle, so a **single versioned, prebuilt artifact serves every user**. That is what
makes shipping the app as a *dependency* — rather than as source to fork — possible.

The orchestration already exists: `scripts/setup.sh` (`bun run setup`) provisions D1+KV,
wires IDs, seeds config, applies the schema, uploads config, and deploys both Workers,
idempotently. It is a CLI in all but name — it is simply unpublished, and all packages
are still `private: true` / `0.0.0`.

## Decision

Distribute StatusBeam as **published packages consumed as a versioned dependency**,
not as a repository to fork. Three coordinated pieces:

1. **Published app + CLI packages.** Publish `@statusbeam/core`, and a
   `statusbeam` **CLI** package that bundles the prebuilt worker + Astro output and
   exposes `setup` / `deploy` / `update` subcommands (wrapping today's `scripts/setup.sh`
   and root `deploy` script). Published with `npm publish --provenance` per the org
   open-source standard.

2. **Two scaffolding vectors, one thin project.** A user's own repo holds *only* the
   user-specific files — `status.config.yml`, `wrangler.jsonc`, and a `deploy.yml` that
   calls the CLI. Users obtain that thin scaffold either way:
   - **`bunx create-statusbeam`** — for terminal/local users.
   - **A separate `statusbeam-template` GitHub template repository** — "Use this
     template" (a clean, unlinked repo, **not** a fork) for GitHub-native users who want
     the repo + CI wired in one click.

   Both emit the identical thin project; the template repo's CI is just the scaffolder's
   output committed.

3. **Updates via the package manager.** Upgrading becomes `bun update @statusbeam/*`
   (or Renovate/Dependabot on the thin repo) — no upstream merge, because the user's repo
   never vendored the app source.

This is upptime's own mature model (a near-empty fork whose logic lives in
`@upptime/uptime-monitor`), adapted to our Cloudflare stack. It **revisits the
distribution assumption** of ADR-0001 but does **not** supersede its tech-stack decision.

## Why a template repo *and* a CLI (not one or the other)

They serve different entry points and cost little to maintain together because both emit
the same scaffold:

- **Template repo** wins for the GitHub-first user: one "Use this template" click yields
  a repo with Actions CI and secrets slots ready. Unlike a fork, a template-created repo
  has **no upstream link**, so there is no implied (conflict-prone) merge-update path —
  updates flow through the package, which is exactly what we want.
- **CLI scaffolder** wins for the local/terminal user and for non-GitHub CI, and it is
  the same binary that later runs `deploy`/`update`, so the tool the user learns at
  `create` time is the tool they keep using.

## Consequences

### Positive

- **Painless updates** — `bun update` replaces fork-merge; users stay current on fixes.
- **Small user surface** — the user repo is ~3 files, all genuinely theirs; app internals
  are opaque, versioned dependencies.
- **Reuses existing work** — `packages/core` is already a package; `setup.sh` + `deploy`
  become the CLI's subcommands with little new logic.
- **Config-independent bundle** — one prebuilt artifact per release deploys for all users;
  no per-user build step required.

### Negative

- **Publishing pipeline to own** — versioning, changelog, and `--provenance` publish for
  the CLI/app packages (release-please already present, but must now cover public packages
  flipped off `private`).
- **Prebuilt bundles shipped in the CLI package** — larger tarball, and the worker/web
  build must be reproducible + pinned at publish time.
- **Per-user state moves, it does not vanish** — resource IDs, domain, and cron still must
  live somewhere; the CLI manages them in the user's `wrangler.jsonc` + a local state file
  instead of a committed fork.
- **Two scaffolding paths to keep in sync** — mitigated by generating the template repo
  from the scaffolder output rather than hand-maintaining it.

### Neutral

- Self-hosters who *want* to fork and modify source can still clone the monorepo; the
  package path is the recommended default, not the only option.
- `DEPLOYMENT.md` and ADR-0001's "fork" framing need updating to describe the package
  flow as primary.

## Alternatives Considered

- **Keep fork + upstream sync (status quo).** Simple, no publishing infra, but the
  merge-conflict update tax is the very problem this ADR exists to remove. Rejected as the
  default; retained as an escape hatch for source-level forkers.
- **Pure CLI, no user repo** (`bunx statusbeam deploy`, config as a local file only).
  Cleanest "no fork" UX, but discards the free GitHub Actions CI/CD that a repo provides
  and gives users nowhere to store `wrangler.jsonc`/secrets under version control.
  Rejected as the *sole* mechanism; its deploy engine is reused as the CLI core.
- **Template repo only, no CLI.** Covers GitHub users but leaves local/terminal users and
  non-GitHub CI without a first-class path, and still needs a deploy engine — which is the
  CLI. Rejected in favor of shipping both from one codebase.

## Amendment (accepted with refinements)

Implementation settled two points the original proposal left open or slightly overstated:

- **Separate app packages, not a bundled blob.** `@statusbeam/worker` and
  `@statusbeam/web` are published as independent versioned packages; the new
  `@statusbeam/cli` (bin `statusbeam`) and the thin user repo consume them. There is
  no single CLI package that vendors a prebuilt worker + Astro output — the deploy
  engine and the app artifacts version separately.
- **"Config-independent bundle" holds for code, not for the web *deploy config*.**
  The claim is exactly right for the **worker** (wrangler bundles its TS at deploy;
  nothing user-specific is compiled in) and for the **web JS bundle** (services,
  incidents, and locale are all runtime-from-KV). But `@astrojs/cloudflare` fuses the
  wrangler config — D1/KV ids, routes, cache — into the generated deploy config *at
  `astro build` time*. A prebuilt `dist/` would therefore carry the maintainer's
  placeholder ids. So `@statusbeam/web` **ships source and builds per-user**: the CLI
  runs `astro build` with `STATUSBEAM_WRANGLER_CONFIG` pointed at the user's own
  wrangler config, then `wrangler deploy`. The "no per-user build step" benefit applies
  to the worker; the web layer takes a fast per-user build. This is the accepted, honest
  shape of the tradeoff, not a regression.

The thin user repo therefore holds `status.config.yml` + **two** wrangler configs
(`wrangler.worker.jsonc`, `wrangler.web.jsonc`) + a `deploy.yml` that runs
`statusbeam deploy`, and a `devDependency` on `@statusbeam/cli`.

## Follow-up (implementation, not part of this decision)

- Flip `apps/*` and `packages/core` off `private: true` / `0.0.0`; decide package
  boundaries (single `statusbeam` CLI bundling prebuilt output vs. separately published
  app packages).
- Extract `scripts/setup.sh` + root `deploy` into `packages/cli` with a `statusbeam`
  bin (`setup` / `deploy` / `update`).
- Author `create-statusbeam` and the `statusbeam-template` repo from shared scaffold
  templates (`wrangler.jsonc`, `status.config.yml`, `deploy.yml`).
- Update `DEPLOYMENT.md` to lead with the package flow; keep the manual/fork path as an
  appendix.
