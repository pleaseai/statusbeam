# ADR-0005: EmDash distribution: one native plugin

## Status

Accepted

Supersedes [ADR-0004](0004-emdash-plugin-distribution.md), except for the parts listed
under "What stays from ADR-0004".

**Deciders:** StatusBeam maintainers

## Date

2026-10-27

## Context

ADR-0004 shipped StatusBeam for EmDash as a sandboxed engine plugin plus a plain Astro
component library. It chose the sandbox for two reasons:

1. A site can install the engine from the registry, without a code change.
2. The engine runs without the site's full authority.

The sandbox also cost the engine a lot. Worker Loader gives each invocation 10
subrequests, and every bridge call counts, so one run had to be sharded across up to 8 cron
tasks of about 5 monitors each. The host's fetch buffers the whole body, so latency was
time to the last byte, and a body over 8 MiB could not be probed. The admin page was Block
Kit only, a single YAML form.

The next planned feature was a real admin UI: a monitor editor with field-level errors, a
status overview, and a dashboard widget. EmDash allows a React admin only in a native plugin
(`adminEntry`). A native plugin is a trusted site dependency: the site installs it with a
code and config change, and it runs with the site's authority. A site that installs one
native plugin for the admin therefore gains nothing from also sandboxing the engine, and
both reasons for the sandbox stop holding:

- The registry install without a code change is gone, because the site changes its code to
  register the admin plugin.
- The engine does not run with less authority, because the same site already trusts the
  package that ships it.

Three more facts from the EmDash 1.3.1 source and the T001 spike
(`apps/emdash-demo/results/2026-10-27/native-plugin.md`) shaped the design:

1. **A native plugin can run in `plugins: []` with no sandbox runner.** It has no
   subrequest or CPU cap per invocation. Each hook runs under EmDash's hook timeout (5 s by
   default), which the plugin raises to 25 s for the cron hook, so one scheduled task can probe
   every monitor.
2. **The host exports `createUnrestrictedHttpAccess`.** It wraps a caller-supplied `fetch`
   with the host's DNS-aware SSRF guard and its 5-hop redirect cap. A fetch that resolves at
   response headers and cancels the body therefore measures time to headers, as the
   standalone Worker does. On both Node and Cloudflare (workerd), a 3 s body measured about
   0.8 s to headers against about 3.6 s to the full body. A 9 MiB body returned `up` 200.
   Requests to `127.0.0.1`, `169.254.169.254`, a 302 redirect to `169.254.169.254`, and a
   name that resolves to `127.0.0.1` were all refused by the host.
3. **Cron differs per host.** Node fires from an in-process timer, Cloudflare `astro dev`
   from a bridge that polls once a minute, and a Cloudflare build from the Worker's
   `scheduled()` handler. `ctx.cron.schedule()` is an upsert that moves the next run to the
   next match, so calling it on every run keeps postponing a task that a per-minute trigger
   polls.

## Decision Drivers

- The admin needs a React UI, which EmDash allows only in a native plugin.
- Probe latency must match the standalone Worker, so the same monitor grades the same.
- Probes must keep the host's SSRF protection.
- Standalone and plugin must share one config schema and one wire contract.

## Decision

Ship StatusBeam for EmDash as **one native plugin**, `@statusbeam/emdash-plugin`, with the
plugin id `statusbeam`. It replaces the sandboxed engine and absorbs the Portable Text block
that `@statusbeam/emdash-ui` used to register.

1. **The plugin.** It contains the engine, the React admin, and the status block. A site
   installs it as a trusted dependency:

   ```ts
   import { statusbeam } from '@statusbeam/emdash-plugin'

   emdash({ plugins: [statusbeam({ allowedOrigins: ['https://status.example.com'] })] })
   ```

   - The package ships TypeScript and `.astro` source, which the site's Vite and Astro
     compile. It has no build step and no `emdash-plugin.jsonc`. The entries are `.` (the
     descriptor), `./plugin` (`createPlugin`), `./admin` (React pages), and `./astro` (the
     block renderer).
   - The site provides the peers `emdash ~1.3.1`, `astro ^7`, `react ^19`,
     `@cloudflare/kumo 2.6.0`, and `@emdash-cms/admin ~1.3.1`.
   - `allowedOrigins` restricts the origins a Status block may fetch. The descriptor throws
     on an entry that is not an http(s) origin, so a typo fails the site build.
   - Routes keep the base `/_emdash/api/plugins/statusbeam`, so the public paths do not change.

2. **Header-time probing behind the host's guard.** HTTP checks run through
   `createUnrestrictedHttpAccess('statusbeam', headerOnlyFetch)`. `headerOnlyFetch` resolves
   at headers and cancels the body. This keeps the host's SSRF protection instead of copying
   it, and it restores the header-time latency that ADR-0004's probe contract had given up.
   Checks that must read the body (Statuspage, incident.io, Sentry, AI Gateway) and notification
   deliveries use the normal `ctx.http.fetch`.

   `createUnrestrictedHttpAccess` is **undocumented**. The `emdash ~1.3.1` peer pins the
   line on which it and `emdash/internal/plugin-test-runtime` were verified.
   Re-verify them, and rerun the spike measurements, before widening the range.

3. **One check task, one daily maintenance task.** A 5-minute `check` task probes all
   monitors concurrently, each under its own 10 s deadline, so a hung response grades `down`
   without delaying the rest. A daily `maintenance` task prunes history older than 90 days.
   Both tasks, and every config save, reconcile the schedule. Reconcile creates only a task
   that is missing or whose schedule changed, because `schedule()` resets the next run.
   The check writes one poll snapshot (`snapshot:poll`). Each webhook writes its own
   `snapshot:webhook:{slug}` key, and readers merge them. Poll and webhook bucket rows and
   snapshot keys stay separate, because a run and a webhook can write at once. The poll
   snapshot is one KV value in one `options` row, and D1 limits a row to 2 MB (about 6 to 9 KB
   per monitor once 90 days of history fill in, with stored errors capped at 300 characters),
   so the plugin accepts at most 200 monitors. Standalone has no such limit.

4. **Config stays YAML.** The monitor configuration is the YAML text under the `config`
   setting, written with a revision-checked `compareAndSet`. The editor works on the parsed
   object. The server serializes it, validates it with core's schema plus the plugin's own
   rules, and returns issues with field paths. Standalone and plugin therefore keep one
   schema.

5. **Secrets stay in encrypted settings.** The Slack URL, the generic webhook URLs, the
   inbound webhook secret, and the Sentry token live in the plugin's `settingsSchema`.
   Administrators edit them on EmDash's generated plugin settings page. The admin page shows
   only "set" or "not set" for each, never a value.

## What stays from ADR-0004

- **The component library.** `@statusbeam/emdash-ui` remains a plain Astro component
  library that reads the public JSON from a base URL. It is now components and the client
  only. It has no plugin entry and no `emdash` peer. The plugin depends on it, because the
  block renderer imports its components.
- **The core-owned wire contract (contract version 1).** `packages/core` owns the public
  status response schema. The plugin's public routes and the standalone `/api/*` endpoints
  both produce it, as an unwrapped `application/json` body, and the library parses it.
- **Two sources for the page.** The Status block and the components read either this
  plugin's routes or a standalone deployment's `/api/*`.

ADR-0004's sandboxed-engine decision, its call-budget and sharding design, its buffered-fetch
probe contract, and its Spike results describe a design that no longer ships. The spike
results stay in ADR-0004 as the record of why those limits existed.

## Consequences

### Positive

- A React admin: a monitor editor with field-level errors, a status overview, a dashboard
  widget, and an on-demand test of one monitor.
- Latency is time to headers, as on the standalone Worker, and a body over 8 MiB is graded
  by its status code. Plugin and standalone numbers are comparable again.
- No call budget, sharding, or capacity table. One task checks all monitors.
- No sandbox runner or Worker Loader requirement. The plugin loads in `plugins: []` on Node
  and Cloudflare.
- The host's SSRF guard protects every probe, including redirect hops.
- One package for engine, admin, and block.

### Negative

- **Installation is a trusted site dependency.** It needs a code and config change, runs
  with the site's full authority, and cannot be installed from the registry. Site operators
  must review it like any other server-side dependency.
- **A plugin-hosted status page goes down with the CMS it reports on.** A CMS or host outage
  stops checks and the page together. Use a standalone deployment when independence
  matters; the page can still read from it. The EmDash guide says so.
- **A dependency on an undocumented EmDash export.** `createUnrestrictedHttpAccess` can
  change in a minor release. The `~1.3.1` peer limits the risk, and every upgrade needs a
  re-verification.
- The `tcp` and `ssl` checks still run as HTTP checks, and `delivery: queue` is still an
  error, as in ADR-0004.
- Public plugin routes still cannot set `Access-Control-Allow-Origin` or `Cache-Tag`, so
  browsers on other origins cannot read them and a status change reaches the edge cache only
  when the entry expires.
- **Known gaps.**
  - The sidebar labels "Status" and "Monitors" are English only, because the host reads them
    before any React runs. Page content is translated.
  - The monitor form does not edit Sentry or AI Gateway monitor blocks. A save preserves them.
  - The first save from the admin drops YAML comments, because the server serializes the
    parsed object.
- Existing installs of the sandboxed engine must migrate: the site moves the plugin from
  `sandboxed` to `plugins` and can drop its sandbox runner.

### Neutral

- ADR-0002's standalone packages remain the primary distribution.
- Stored `statusbeam-status` blocks keep rendering, because content stores only the block
  type and its field ids.

## Alternatives Considered

- **Sandboxed engine plus a native admin-only plugin.** This keeps the registry install of
  the engine. A site that wants the admin installs two packages, and both are trusted
  anyway, so the engine gains no safety. The sharding, the call budget, and the buffered
  latency stay. Rejected: it keeps ADR-0004's costs without its benefit.
- **Run the sandboxed bundle in-process.** It would reuse one artifact. The sandboxed
  `format: "standard"` cannot carry `adminEntry` or `componentsEntry`, so it cannot ship the
  React admin or the block renderer. Rejected.
- **A structured store replacing the YAML.** It would suit a form better. It breaks the
  single schema that standalone and the plugin share, and it would need a second validation
  path. Rejected.
- **Our own SSRF check around the global `fetch`.** It avoids the undocumented export. It
  would be a weaker copy of the host's check, which resolves DNS and caps redirects, and we
  would have to keep it current. Rejected.
- **An in-process block renderer.** The block would read plugin data without an HTTP round
  trip. EmDash offers no host API for plugin data in Astro components, so the block keeps
  its HTTP read. Not built; a host API would change this.
- **Lingui catalogs for StatusBeam strings.** Core's dictionary already covers English,
  Chinese, Japanese, and Korean. Not built; an EmDash rule that requires Lingui would change
  this.

## References

- [ADR-0004](0004-emdash-plugin-distribution.md): superseded; its Spike results stay as the
  record of the sandbox limits.
- [ADR-0002](0002-package-based-distribution.md): package-based distribution.
- `apps/emdash-demo/results/2026-10-27/native-plugin.md`: the T001 measurements (header-time
  and full-body latency, the 9 MiB body, SSRF refusals including the redirect hop, and cron
  per host).
- EmDash docs: [Choosing a format](https://docs.emdashcms.com/plugins/creating-plugins/choosing-a-format/),
  [React admin](https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/).
