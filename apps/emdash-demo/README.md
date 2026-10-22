# EmDash demo site and ADR-0004 spike harness

This private app is the probe-semantics spike for
[ADR-0004](../../docs/adr/0004-emdash-plugin-distribution.md). It is not published, and
release-please does not track it. The results are in the ADR's
"Spike results (2026-10-22)" section.

The harness has three parts:

| Part | Path | What it does |
|---|---|---|
| Demo site | `astro.config.mjs`, `src/`, `seed/` | A minimal EmDash 1.3.1 site. `SPIKE_MODE` picks the execution mode at build time. |
| Probe plugin | `probe/` | A sandboxed plugin that runs the real `checkSite` from `@statusbeam/core` with `fetchImpl` set to `ctx.http.fetch`. |
| Fixtures | `fixtures/` | A Worker that serves the large, slow-body, streaming, status-code and notification endpoints. |

The app is excluded from the root Bun workspace (`!apps/emdash-demo` in the root
`package.json`). It has its own `bun.lock`, so its Astro 7.4 and EmDash dependencies do
not change the versions that `apps/web` and `apps/docs` resolve.

## Execution modes

| `SPIKE_MODE` | Host | Plugin list | Runner |
|---|---|---|---|
| `worker-loader` | Cloudflare Worker `statusbeam-emdash-spike` | `sandboxed: [probe]` | `sandbox()` from `@emdash-cms/cloudflare` |
| `workerd` | Node (`@astrojs/node`) | `sandboxed: [probe]` | `@emdash-cms/sandbox-workerd/sandbox` |
| `in-process` | Node (`@astrojs/node`) | `plugins: [probe]` | none |

## Probe routes

All routes are public and live under `/_emdash/api/plugins/statusbeam-spike-probe/`. The
probe can reach only the fixture URLs hard-coded in `probe/src/plugin.ts`.

| Route | Query | Measures |
|---|---|---|
| `probe` | `fixture=<name>`, optional `timeoutMs` | One graded `checkSite` result and the raw `ctx.http.fetch` rejection |
| `capacity` | `n`, `notify`, `kvWrites`, `logs`, `parse` | One invocation's config re-validation, probes, notification POSTs and KV writes, step by step |
| `cron-schedule` | `name`, `schedule`, `n`, `notify`, `parse` | Whether `ctx.cron.schedule()` accepts the expression; the task runs the `capacity` steps |
| `cron-results` | none | Scheduled tasks and the last 20 run summaries per task |
| `cron-cancel` | `name` | Cancels a task |

Fixture names: `ok`, `status-503`, `nxdomain`, `big-7mib`, `big-9mib`, `slow-headers-3s`,
`slow-body-3s`, `stream-20s`, `stream-120s`.

## Reproduce the runs

You need Bun, Node 22 or later, and Wrangler logged in to a Cloudflare account on the
Workers paid plan (Worker Loader is paid-only).

1. Build the monorepo once, then install the app and build the probe:

   ```sh
   bun install && bun run build          # repo root
   cd apps/emdash-demo
   bun install
   bun run probe:build
   ```

2. Deploy the fixtures. If you deploy them under another account subdomain, update
   `FIXTURES` in `probe/src/plugin.ts` and rebuild the probe.

   ```sh
   bun run fixtures:deploy
   ```

3. Stage one copy of the site per mode, because each mode needs its own build in
   `dist/`. The script copies the site and the built probe, then runs `bun install`:

   ```sh
   scripts/stage.sh /tmp/spike-wl
   scripts/stage.sh /tmp/spike-workerd
   scripts/stage.sh /tmp/spike-in-process
   ```

   From an ordinary checkout you can instead build one mode at a time in place. Do not
   build in place from a checkout nested inside another checkout, such as a git
   worktree under `.claude/worktrees/`. There, Astro's Vite tsconfig-paths lookup climbs
   into the outer checkout's `tsconfig.json`, and the build fails with
   `Tsconfig not found astro/tsconfigs/strict`. The same lookup breaks the `apps/web`
   build in such a worktree.

4. Worker Loader mode. Create the D1 database, put its id in `wrangler.jsonc`, then
   create the R2 bucket and deploy. Wrangler provisions the `SESSION` KV namespace on
   the first deploy.

   ```sh
   cd /tmp/spike-wl
   bunx wrangler d1 create statusbeam-emdash-spike
   bunx wrangler r2 bucket create statusbeam-emdash-spike-media
   bun run deploy:worker-loader
   ```

   The site Worker sets the `global_fetch_strictly_public` compatibility flag. Without
   it, a fetch from the site Worker to the fixture Worker on the same `workers.dev`
   subdomain returns 404 instead of reaching the fixture.

5. Node modes. Build and start each staged copy on its own port:

   ```sh
   cd /tmp/spike-workerd && bun run build:workerd && PORT=4401 HOST=127.0.0.1 bun run start
   cd /tmp/spike-in-process && bun run build:in-process && PORT=4402 HOST=127.0.0.1 bun run start
   ```

6. Run the suites from `apps/emdash-demo`. Each prints one JSON line per run.

   ```sh
   bun scripts/run-spike.ts https://statusbeam-emdash-spike.<subdomain>.workers.dev worker-loader all
   bun scripts/run-spike.ts http://127.0.0.1:4401 workerd all
   bun scripts/run-spike.ts http://127.0.0.1:4402 in-process all
   bun scripts/bench-parse.ts            # local parseConfig cost
   bun scripts/capacity.ts <site> "n=0&kvWrites=12" "n=10&putMany=1" "n=0&parse=1000"
   ```

   The 2026-10-22 output is in `results/2026-10-22/`, with the ad-hoc runs in
   `adhoc.txt`.

7. Cron cadence and capacity. Register tasks, wait for a few ticks, then read the
   summaries. `cron-results` keeps only runs whose closing KV write succeeded, so also
   count fixture requests with `bunx wrangler tail statusbeam-emdash-spike-fixtures`.

   ```sh
   S=<site>/_emdash/api/plugins/statusbeam-spike-probe
   curl "$S/cron-schedule?name=five&schedule=*/5%20*%20*%20*%20*&n=12"
   curl "$S/cron-schedule?name=one&schedule=*%20*%20*%20*%20*&n=3"
   curl "$S/cron-schedule?name=tensec&schedule=*/10%20*%20*%20*%20*%20*&n=1"
   curl "$S/cron-results"
   ```

## Cloudflare resources

The spike created these resources on account `20f4dac8c33060fc42fd560d8e90b630`. None
of them is shared with `statusbeam-worker`, `statusbeam-web` or the `statusbeam.dev`
zone.

| Resource | Name | Id |
|---|---|---|
| Worker | `statusbeam-emdash-spike` | — |
| Worker | `statusbeam-emdash-spike-fixtures` | — |
| D1 database | `statusbeam-emdash-spike` | `c22e9fd7-164b-49fb-a365-f8478092e080` |
| R2 bucket | `statusbeam-emdash-spike-media` | — |
| KV namespace | `statusbeam-emdash-spike-session` (auto-provisioned `SESSION`) | `08709f50694a4f029c0ddfcba648c52e` |

Tear them down with:

```sh
bunx wrangler delete statusbeam-emdash-spike
bunx wrangler delete statusbeam-emdash-spike-fixtures
bunx wrangler d1 delete statusbeam-emdash-spike
bunx wrangler r2 bucket delete statusbeam-emdash-spike-media
bunx wrangler kv namespace delete --namespace-id 08709f50694a4f029c0ddfcba648c52e
```
