# Native plugin spike (T001, 2026-10-27)

This run checks that StatusBeam can run as one native EmDash 1.3.1 plugin, with the id
`statusbeam`, registered in `plugins: []` and with no sandbox runner. It covers the Node host
(`SPIKE_MODE=native`) and the Cloudflare host (`SPIKE_MODE=native-cf`). Track:
`emdash-native-plugin-20261027`, issue #110.

The plugin code is in `packages/emdash-plugin/src`:

| Module | Role |
|---|---|
| `descriptor.ts` | `statusbeam(options)`, the site's native descriptor (`entrypoint` and `adminEntry`) |
| `native.ts` | `createPlugin()` and `definePlugin()`, with the `spike-tick` cron task and the public `spike-probe` and `spike-cron` routes |
| `http.ts` | `headerOnlyFetch()` and `createProbeHttp()`, which wraps `createUnrestrictedHttpAccess('statusbeam', headerOnlyFetch(...))` |
| `admin/index.tsx` | Placeholder React page (`/`) and dashboard widget (`status`), shipped as TypeScript source |

## Verdict

| Check | Node (`native`) | Cloudflare (`native-cf`) |
|---|---|---|
| Builds with `plugins: [statusbeam()]` and no runner | Pass: `astro dev`, and `astro build` plus `node dist/server/entry.mjs` | Pass: `astro dev` (workerd), and `astro build` plus `wrangler dev --local` |
| React page and widget render from TS source | Pass: `native-node-page.png`, `native-node-dashboard.png` | Pass: `native-cf-page.png`, `native-cf-dashboard.png` |
| Scheduled task fires | Pass: `NodeCronScheduler` timer | Pass: the dev scheduler bridge, and the Worker's `scheduled()` handler |
| Header-time latency on a slow body | Pass: 837 ms, against 3607 ms for the full body | Pass: 787 ms, against 3649 ms for the full body |
| A body over 8 MiB is graded by status | Pass: `up` 200 | Pass: `up` 200 |
| `127.0.0.1` refused | Pass | Pass |
| `169.254.169.254` refused | Pass | Pass |
| Redirect to `169.254.169.254` refused | Pass | Pass |
| Hostname that resolves to `127.0.0.1` refused (DNS check) | Pass | Pass |

The `runtime` field in each probe response is `navigator.userAgent`. It reads `Node.js/24`
on Node and `Cloudflare-Workers` under workerd, so each run executed on the host it names.

## Probe targets

The ADR-0004 fixture Worker (`statusbeam-emdash-spike-fixtures`) was deleted on 2026-10-22,
and its URLs now return 404. This spike does not deploy a replacement. The probe uses fixed
public endpoints instead (`SPIKE_TARGETS` in `native.ts`):

| Target | URL | Purpose |
|---|---|---|
| `slow-body-3s` | `https://httpbin.org/drip?duration=3&numbytes=10&delay=0&code=200` | Sends the headers at once and the body over 3 s |
| `big-9mib` | `https://speed.cloudflare.com/__down?bytes=9437184` | Serves a 9 MiB body |
| `ok` | `https://httpbin.org/status/200` | Baseline round trip |
| `loopback` | `http://127.0.0.1/` | Loopback IP literal |
| `dns-loopback` | `http://localhost.direct/` | Public name with an A record of 127.0.0.1, not on EmDash's wildcard-DNS denylist |
| `metadata` | `http://169.254.169.254/latest/meta-data/` | Cloud-metadata IP literal |
| `redirect-to-metadata` | `https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/` | Public URL that returns a 302 to the metadata address |

`GET /_emdash/api/plugins/statusbeam/spike-probe?target=<name>&body=1` runs the real
`checkSite` from `@statusbeam/core` twice. The first run, `header`, goes through
`createProbeHttp`. The second run, `body`, goes through the host's own `ctx.http.fetch`,
which buffers the body. `headersMs` is the time from the final hop's dispatch to its headers,
so it excludes the guard's DNS lookups.

## Results

The raw output is in `native-node-probe.jsonl`, `native-cf-probe.jsonl` (dev servers),
`native-cf-wrangler-probe.jsonl` and `native-node-prod-probe.json` (production builds).
`responseTime` is core's figure, in ms.

| Target | Node header | Node body | Cloudflare header | Cloudflare body |
|---|---|---|---|---|
| `slow-body-3s` | `up` 200, 837 (headers 768) | `degraded` 200, 3607 | `up` 200, 787 (headers 772) | `degraded` 200, 3649 |
| `big-9mib` | `up` 200, 53 | `down` 0, body limit | `up` 200, 55 | `down` 0, body limit |
| `ok` | `up` 200, 758 | `up` 200, 251 | `up` 200, 192 | `up` 200, 197 |

The production builds give the same picture. On Node, `slow-body-3s` took 831 ms in header
mode and 3975 ms in body mode. Under `wrangler dev`, it took 1057 ms and 3471 ms, and
`big-9mib` was `up` 200 in 58 ms. The `slow-body-3s` header figure is the httpbin.org round
trip from this network: `ok` is in the same range on Node.

In body mode, the 9 MiB body fails with
`Plugin HTTP response body exceeds the 8388608 byte limit`.

### Refusals

Every refusal came from the host guard inside `createUnrestrictedHttpAccess`, identically on
both hosts, in both header mode and body mode. The URL never reached `fetch`:

- `127.0.0.1`: `Plugin "statusbeam": blocked fetch to "127.0.0.1": URLs targeting non-public IP addresses are not allowed`
- `169.254.169.254`: `Plugin "statusbeam": blocked fetch to "169.254.169.254": URLs targeting non-public IP addresses are not allowed`
- The 302 to `169.254.169.254`: the same message, raised on the redirect hop. `headersMs`
  shows that the first hop was fetched and the second was not.
- `localhost.direct`: `Plugin "statusbeam": blocked fetch to "localhost.direct": Hostname resolves to a non-public IP address`
- `localtest.me`, tried first, is refused earlier by EmDash's static wildcard-DNS denylist
  (`URLs targeting wildcard DNS services are not allowed`). For that reason, the DNS check is
  exercised with `localhost.direct`.

### Cron

`plugin:activate` schedules `spike-tick` (`* * * * *`). `GET .../spike-cron` schedules the task
only when it is missing, then lists the tasks and the last 20 runs, which the task records in
KV.

- Node dev: the `NodeCronScheduler` timer fires the task on the minute. `native-node-cron.json`
  shows runs at 08:35:00.001, 08:37:00.001 and 08:38:00.002. After the server was stopped from
  08:39 to 08:55, the overdue task ran once on restart, not once per missed minute
  (`native-node-cron-log.txt`).
- Cloudflare `astro dev`: the dev scheduler bridge POSTs `/_emdash/api/dev/scheduled-tasks`
  every 60 s from server start, so a task runs up to about 60 s after it is due. It fired at
  08:53:40 for 08:53:00 (`native-cf-cron-log.txt`). `/__scheduled` does not apply here.
- Cloudflare production build under `wrangler dev --local --test-scheduled`: `/__scheduled`
  returns 404 in this Wrangler version. Use
  `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=statusbeam-emdash-spike` with the
  body `{"cron":"* * * * *"}`. That call runs the Worker's `scheduled()` handler
  (`createScheduledHandler()` in `src/worker.ts`), which fired the task
  (`native-cf-wrangler-cron-log.txt`).

## EmDash behavior to know

- `ctx.cron.schedule()` is an upsert that resets `next_run_at` to the next match. If you call
  it on every request or every run, a task that a once-a-minute trigger polls is never found
  due. The first version of the `spike-cron` route did this on Cloudflare: polled every 5 s,
  the task never ran. Reconcile code must schedule only a task that is missing or changed.
- Native route handlers that return a plain object are wrapped as `{"success":true,"data":...}`.
- `localtest.me`, `lvh.me`, `nip.io`, `sslip.io`, `xip.io` and `traefik.me` are refused by
  name before any DNS lookup.
- The first `astro dev` start in `native-cf` mode after a config change re-optimized its
  dependencies (`yaml`), reloaded, and then left requests hanging. The next start on the same
  port (4431) also hung. Every later start, on other ports, answered normally with the same
  plugin code. If the first Cloudflare dev start hangs, restart it on a fresh port.
