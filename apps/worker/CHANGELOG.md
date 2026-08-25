# Changelog

## [0.1.1](https://github.com/pleaseai/statusbeam/compare/worker-v0.1.0...worker-v0.1.1) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @statusbeam/core bumped to 0.2.0

## 0.1.0 (2026-07-31)


### Features

* add Sentry Uptime adapter (webhook + poll backstop) ([#53](https://github.com/pleaseai/statusbeam/issues/53)) ([e2970b1](https://github.com/pleaseai/statusbeam/commit/e2970b13be7f11ddb0ff3d246e4618b7acacc939))
* close the cache-purge loop with shared Cache-Tag emit ([#10](https://github.com/pleaseai/statusbeam/issues/10)) ([193d3f9](https://github.com/pleaseai/statusbeam/commit/193d3f9c2a2ee2db5e9ba821c8462e63f5c20665))
* incident timeline ([#7](https://github.com/pleaseai/statusbeam/issues/7)) ([6549a74](https://github.com/pleaseai/statusbeam/commit/6549a74771528c715a05c1a4e6f2f140efd0aa7d))
* package-based distribution (ADR-0002) ([#30](https://github.com/pleaseai/statusbeam/issues/30)) ([ae8b017](https://github.com/pleaseai/statusbeam/commit/ae8b0174276042cdc87dd0e2ec986643e79c26ab))
* scaffold monorepo (Astro web + Cron Worker + core) ([b1203f9](https://github.com/pleaseai/statusbeam/commit/b1203f9e18fb276c016f106da6edeaf7c046ec3b))
* **web:** add 90-day uptime timeline per component ([#6](https://github.com/pleaseai/statusbeam/issues/6)) ([a498f09](https://github.com/pleaseai/statusbeam/commit/a498f099406a52c433a43c3a0392294cf6d36dcf))
* **worker:** ingest Atlassian Statuspage webhooks for real-time status ([#33](https://github.com/pleaseai/statusbeam/issues/33)) ([9f56c61](https://github.com/pleaseai/statusbeam/commit/9f56c61d4a89f5f5aee00af4bb4bee3d1b918256))
* **worker:** notify subscribers and purge edge cache on status change ([#8](https://github.com/pleaseai/statusbeam/issues/8)) ([8d4fee7](https://github.com/pleaseai/statusbeam/commit/8d4fee73c6af3a5efb7d947fd587a1d98015212c))
* **worker:** optional Cloudflare Queues path for reliable notification delivery ([#43](https://github.com/pleaseai/statusbeam/issues/43)) ([23ec7f3](https://github.com/pleaseai/statusbeam/commit/23ec7f317d1371f55339f5d7b136fda6aba04a1a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @statusbeam/core bumped to 0.1.0
