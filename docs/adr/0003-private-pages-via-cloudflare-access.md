# ADR-0003: Private/internal pages via Cloudflare Access

## Status

Proposed

**Deciders:** StatusBeam maintainers

## Date

2026-07-09

## Context

StatusBeam serves a **public** status page by default: an Astro SSR Worker on a
hostname/route, fronted by Workers Cache, reading a snapshot from KV/D1
(`DEPLOYMENT.md`, ADR-0002). A recurring ask is a **private/internal** status page —
one visible only to employees or a specific audience, not the public internet.

The question is not *whether* to support it but **where the authentication boundary
lives**. Three properties of the existing design constrain the answer:

1. **Edge-cache-centric SSR.** Rendered pages are cached per URL at the edge; hits skip
   the Worker and D1 entirely (`apps/web/wrangler.jsonc` → `cache.enabled: true`).
   Per-viewer authorization *inside* the app fights this model — a page whose content
   varies by who is looking cannot be a shared cache entry.
2. **Package-based distribution (ADR-0002).** The app ships as a versioned dependency;
   the user's repo holds only `status.config.yml` + two `wrangler.*.jsonc`. Any auth
   code baked into `@statusbeam/web` becomes complexity **every** deployer carries,
   configured through *our* abstraction, for an identity provider we don't know.
3. **Machine-facing endpoints exist.** The web app exposes cookie-less public endpoints
   meant for automated consumers: badges (`/api/badge/[slug]/*`, embedded in READMEs and
   fetched by GitHub's image proxy), feeds (`feed.rss`/`feed.atom`/`history.*`), and JSON
   (`/api/status.json`, `/api/status/[slug].json`). A blanket gate breaks all of them.

Cloudflare Access is an edge identity gate configured in Zero Trust (an Access
**application** on a hostname/path + a **policy**). It runs **ahead of** the Worker and
of Workers Cache in the request pipeline, so it can protect a whole status page with
**zero application code**, and unauthenticated requests never reach cached content.

## Decision

**Authentication for private pages lives at the edge (Cloudflare Access), not in the
StatusBeam app.** `@statusbeam/web` and `@statusbeam/worker` ship **no login, session, or
authorization code.** We support two deployment topologies, both configured outside the
app:

1. **Fully-gated internal page.** Put one Access self-hosted application on the status
   page's hostname (a custom domain on a Cloudflare zone in your account — `workers.dev`
   subdomains cannot carry Access), with an Allow policy scoped to an email domain or IdP
   group. The entire page — pages, badges, feeds, and JSON — is gated. App code unchanged.

2. **Public page + separate internal page.** Keep the public deployment as-is and deploy
   a **second copy** (a second `wrangler.web.jsonc`: different Worker `name` + hostname,
   its own `status.config.yml`/KV snapshot) on an internal hostname protected by Access.
   Two Workers, two configs, one of them gated — no per-viewer logic anywhere.

**Machine endpoints are gated with the page by default.** Deployers who want badges/feeds
public *while the page is private* opt in explicitly: a more-specific Access application
on the sub-path (e.g. `status.example.com/api`) with a **Bypass** policy, or an Access
**service token** for trusted CI/monitors. This is a documented per-deployer decision, not
a default and not app behavior.

The primary deliverable is therefore **documentation** (a `DEPLOYMENT.md` section) plus
this ADR fixing the boundary. No change to `apps/web`, `apps/worker`, or `packages/core`.

## Consequences

### Positive

- **Zero app-code surface.** No auth to build, test, version, or CVE-patch in StatusBeam;
  identity, MFA, and session lifetime are Cloudflare's problem, integrated with the
  deployer's existing IdP (Google, Okta, GitHub, one-time PIN, …).
- **Cache model intact.** Access gates ahead of Workers Cache, so private content is never
  served from cache to an unauthenticated visitor, and cache-purge-by-tag still works.
- **Composable topologies.** "Fully internal" and "public + internal" are the same
  primitive (an Access app on a hostname) applied once or twice — no new concepts.

### Negative

- **Out-of-band setup.** Access lives in the Zero Trust dashboard/API, not in
  `wrangler.*.jsonc`; `statusbeam setup` does not provision it today, so the deployer
  configures it manually (documented, but a separate step).
- **Machine endpoints need a conscious choice.** Badges/feeds/JSON break under a blanket
  gate unless the deployer adds Bypass/service-token policies — a footgun if undocumented,
  which is exactly why this ADR mandates documenting it.
- **Two-page topology duplicates a deployment.** Public + internal means two Workers and
  two configs to keep in sync, rather than one page with visibility rules.

### Neutral

- Requires a **custom domain** on a Cloudflare zone in the account; `workers.dev` alone
  can't host Access. Most private-page users want a branded internal hostname anyway.
- Defense-in-depth (verifying the `Cf-Access-Jwt-Assertion` JWT inside the Worker) remains
  *possible* as a future opt-in but is deliberately **not** required here.

## Alternatives Considered

- **App-level auth (login/session in `@statusbeam/web`).** Puts a password or OAuth flow
  in the app. Rejected: every deployer inherits auth complexity and an attack surface for
  an IdP we can't anticipate; it duplicates what Access does better; and per-viewer
  responses defeat the edge cache the whole architecture is built on.
- **Per-service visibility in a single page** (`public`/`private` flags per service,
  filtered by viewer). Rejected as the mechanism: it forces per-viewer rendering (cache
  fragmentation or bypass), splits the KV snapshot, and still needs *some* auth to know the
  viewer — i.e. Access anyway. The two-page topology delivers the same outcome with no app
  change. May be revisited if strong demand appears.
- **Provision Access from the CLI/Terraform** (`statusbeam setup --access`). Attractive for
  reproducibility, but `wrangler` cannot manage Access resources — it needs Cloudflare API
  or Terraform calls, and IdP config varies per org, lowering the payoff for OSS. Deferred:
  document the manual setup now; add CLI provisioning if demand warrants.

## Follow-up (implementation, not part of this decision)

- Add a **"Private / internal pages (Cloudflare Access)"** section to `DEPLOYMENT.md`:
  self-hosted application on the hostname, Allow policy, the badge/feed Bypass/service-token
  opt-in, and the two-page topology recipe.
- Consider a future `statusbeam setup --access` that provisions the Access application via
  the Cloudflare API (separate ADR/decision if pursued).
