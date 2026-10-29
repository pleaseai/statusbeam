# Tech Debt Tracker

> Tracked across all tracks. Updated during implementation and retrospectives.

## Active

| ID | Source Track | Description | Priority | Created |
|----|------------|-------------|----------|---------|
| TD-003 | emdash-distribution-20261022 | Release `@statusbeam/core` together with `emdash-plugin`/`emdash-ui`: published core 0.2.0 lacks `./contract` | High | 2026-10-22 |
| TD-004 | emdash-distribution-20261022 | Redeploy `statusbeam-web` so live `/api/*` bodies carry `version: 1` for `emdash-ui` | Medium | 2026-10-22 |
| TD-006 | emdash-native-plugin-20261027 | The native plugin's final HEAD was not re-run on the Cloudflare host (`native-cf`); only Node was verified after the T001 spike | Medium | 2026-10-29 |
| TD-007 | emdash-native-plugin-20261027 | End-to-end install of the packed `@statusbeam/emdash-plugin` tarball into a fresh Astro site is unverified | Medium | 2026-10-29 |
| TD-008 | emdash-native-plugin-20261027 | The admin monitor form does not edit Sentry or AI Gateway blocks (FR-7), and the sidebar labels are English only (NFR-1) | Low | 2026-10-29 |
| TD-009 | emdash-native-plugin-20261027 | The `snapshot:config-error` record is written by a run but never shown in the admin | Low | 2026-10-29 |
| TD-010 | emdash-native-plugin-20261027 | No regression test pins that the public routes read the snapshot only for a valid configuration (9c39143) | Low | 2026-10-29 |

## Resolved

| ID | Source Track | Description | Resolved In | Date |
|----|------------|-------------|-------------|------|
| TD-001 | emdash-distribution-20261022 | Full `apps/emdash-demo` install with the engine under a sandbox runner is unverified | emdash-native-plugin-20261027 (obsolete: the sandboxed engine was removed) | 2026-10-29 |
| TD-002 | emdash-distribution-20261022 | Unverified whether `ctx.settings.*` / `ctx.cron.*` count against the Worker Loader 10-call bridge budget (the budget assumes they do) | emdash-native-plugin-20261027 (obsolete: the sandboxed engine was removed) | 2026-10-29 |
| TD-005 | emdash-distribution-20261022 | A config save reconciles only ~3 shard operations; larger changes wait for the next save or daily maintenance | emdash-native-plugin-20261027 (obsolete: the sandboxed engine was removed) | 2026-10-29 |
