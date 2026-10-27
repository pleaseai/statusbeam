---
name: emdash-native-host-tests
description: How packages/emdash-plugin native host tests boot EmDashRuntime under bun (preload stubs, per-host db entrypoint, settings/secrets, cron hook)
metadata:
  type: project
---

Run: `bun run --cwd packages/emdash-plugin test:host` (= `bun test --preload ./tests/host-preload.ts ./tests/engine.host.ts`); `*.host.ts` is ignored by plain `bun test`.
- Preload stubs six `virtual:emdash/*` modules via `Bun.plugin build.module` and sets `EMDASH_ENCRYPTION_KEY` (secret settings need it).
- `EmDashRuntime.create` caches the db per `config.database.entrypoint`: use a unique entrypoint + temp sqlite file per host, else tests share/lose a db.
- `create()` auto-installs/activates a new config plugin (cron tasks appear without calling activate). Fire cron with `runtime.hooks.invokeCronHook(id, {name, scheduledAt})` -> `.success`.
- Set plain settings by inserting `options` row `plugin:<id>:settings:<key>` (JSON value); secrets via `handlePluginSettingsUpdate(db, id, plugin.admin.settingsSchema, {...})`. Read kv from `options` `plugin:<id>:<key>`, buckets from `_plugin_storage`, tasks from `_emdash_cron_tasks`.
- Host passes request bodies to the injected fetch as bytes; shut down with `runtime.shutdown()`.

**Why:** T002 spent a debug loop on each. **How to apply:** T003/T004 route tests can reuse `newHost` in tests/engine.host.ts with `dispatchPluginApiRequest`.
