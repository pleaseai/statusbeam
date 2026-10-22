# Tech Debt Tracker

> Tracked across all tracks. Updated during implementation and retrospectives.

## Active

| ID | Source Track | Description | Priority | Created |
|----|------------|-------------|----------|---------|
| TD-001 | emdash-distribution-20261022 | Full `apps/emdash-demo` install with the engine under a sandbox runner is unverified | Medium | 2026-10-22 |
| TD-002 | emdash-distribution-20261022 | Unverified whether `ctx.settings.*` / `ctx.cron.*` count against the Worker Loader 10-call bridge budget (the budget assumes they do) | Low | 2026-10-22 |
| TD-003 | emdash-distribution-20261022 | Release `@statusbeam/core` together with `emdash-plugin`/`emdash-ui`: published core 0.2.0 lacks `./contract` | High | 2026-10-22 |
| TD-004 | emdash-distribution-20261022 | Redeploy `statusbeam-web` so live `/api/*` bodies carry `version: 1` for `emdash-ui` | Medium | 2026-10-22 |
| TD-005 | emdash-distribution-20261022 | A config save reconciles only ~3 shard operations; larger changes wait for the next save or daily maintenance | Low | 2026-10-22 |

## Resolved

| ID | Source Track | Description | Resolved In | Date |
|----|------------|-------------|-------------|------|
