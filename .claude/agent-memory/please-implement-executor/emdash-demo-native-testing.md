---
name: emdash-demo-native-testing
description: How to run/verify the native statusbeam plugin in apps/emdash-demo (Node + Cloudflare), cron triggers, and bun test mock.module leak
metadata:
  type: project
---

Verified 2026-10-27 (T001, EmDash 1.3.1):
- `SPIKE_MODE=native|native-cf npx astro dev --host 127.0.0.1 --port N` works in place in the orca worktree (not nested in another checkout). Sign-in: `/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` (the `auth/dev-bypass` path in README is the older one); dismiss the "Get Started" dialog before screenshots. `npx astro dev logs/stop` manage the backgrounded server.
- Plugin code changes are NOT hot-reloaded into the runtime; restart the dev server.
- Cron: Node fires on the minute; Cloudflare dev bridge every 60 s; built Worker via `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=statusbeam-emdash-spike` (`/__scheduled` 404s). `ctx.cron.schedule()` resets next_run_at — never call it unconditionally.
- First native-cf dev start after config change can hang; restart on a fresh port.
- `bun test` `mock.module('emdash')` is process-wide: stubs must spread the real module.
- `*.log` is gitignored repo-wide; commit raw logs as `*-log.txt`.

**Why:** these cost a full debug loop each during T001.
**How to apply:** T002+ native host tests and any demo re-run.
