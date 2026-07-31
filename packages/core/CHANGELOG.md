# Changelog

## [0.2.0](https://github.com/pleaseai/statusbeam/compare/core-v0.1.0...core-v0.2.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* restart versioning at 0.1.0 ([#73](https://github.com/pleaseai/statusbeam/issues/73))

### Features

* add Sentry Uptime adapter (webhook + poll backstop) ([#53](https://github.com/pleaseai/statusbeam/issues/53)) ([e2970b1](https://github.com/pleaseai/statusbeam/commit/e2970b13be7f11ddb0ff3d246e4618b7acacc939))
* badges & public status API (shields.io endpoints) ([#20](https://github.com/pleaseai/statusbeam/issues/20)) ([ed229cd](https://github.com/pleaseai/statusbeam/commit/ed229cdfdbcc301217e031cc9b28145a97f1d946))
* close the cache-purge loop with shared Cache-Tag emit ([#10](https://github.com/pleaseai/statusbeam/issues/10)) ([193d3f9](https://github.com/pleaseai/statusbeam/commit/193d3f9c2a2ee2db5e9ba821c8462e63f5c20665))
* **core:** add Atlassian Statuspage check adapter ([#23](https://github.com/pleaseai/statusbeam/issues/23)) ([bf53f33](https://github.com/pleaseai/statusbeam/commit/bf53f337960883149cbfdcb600d800187c0fcadd))
* **core:** add incident.io status-page check adapter ([#39](https://github.com/pleaseai/statusbeam/issues/39)) ([2f1349c](https://github.com/pleaseai/statusbeam/commit/2f1349cf62122cb4b46df6963af1488eff0e4895))
* **i18n:** add English + CJK internationalization ([#18](https://github.com/pleaseai/statusbeam/issues/18)) ([2b85f7c](https://github.com/pleaseai/statusbeam/commit/2b85f7c345df366ef02af4809c057f0fddddd11b))
* incident timeline ([#7](https://github.com/pleaseai/statusbeam/issues/7)) ([6549a74](https://github.com/pleaseai/statusbeam/commit/6549a74771528c715a05c1a4e6f2f140efd0aa7d))
* package-based distribution (ADR-0002) ([#30](https://github.com/pleaseai/statusbeam/issues/30)) ([ae8b017](https://github.com/pleaseai/statusbeam/commit/ae8b0174276042cdc87dd0e2ec986643e79c26ab))
* scaffold monorepo (Astro web + Cron Worker + core) ([b1203f9](https://github.com/pleaseai/statusbeam/commit/b1203f9e18fb276c016f106da6edeaf7c046ec3b))
* **web:** add 90-day uptime timeline per component ([#6](https://github.com/pleaseai/statusbeam/issues/6)) ([a498f09](https://github.com/pleaseai/statusbeam/commit/a498f099406a52c433a43c3a0392294cf6d36dcf))
* **web:** add explicit dark mode theme toggle ([#24](https://github.com/pleaseai/statusbeam/issues/24)) ([5ab0d1a](https://github.com/pleaseai/statusbeam/commit/5ab0d1a3c59d12c96196a13e6121e13480018644))
* **web:** add RSS and Atom incident-history feeds ([#41](https://github.com/pleaseai/statusbeam/issues/41)) ([d4acb27](https://github.com/pleaseai/statusbeam/commit/d4acb27d7eb98736c4721061b951a64d4fe544f7))
* **web:** per-component response-time charts ([#9](https://github.com/pleaseai/statusbeam/issues/9)) ([41efdc7](https://github.com/pleaseai/statusbeam/commit/41efdc7e40d7f7ec3006a2f57c20aa3458326099))
* **worker:** ingest Atlassian Statuspage webhooks for real-time status ([#33](https://github.com/pleaseai/statusbeam/issues/33)) ([9f56c61](https://github.com/pleaseai/statusbeam/commit/9f56c61d4a89f5f5aee00af4bb4bee3d1b918256))
* **worker:** notify subscribers and purge edge cache on status change ([#8](https://github.com/pleaseai/statusbeam/issues/8)) ([8d4fee7](https://github.com/pleaseai/statusbeam/commit/8d4fee73c6af3a5efb7d947fd587a1d98015212c))
* **worker:** optional Cloudflare Queues path for reliable notification delivery ([#43](https://github.com/pleaseai/statusbeam/issues/43)) ([23ec7f3](https://github.com/pleaseai/statusbeam/commit/23ec7f317d1371f55339f5d7b136fda6aba04a1a))


### Bug Fixes

* **core:** address feed review findings from PR [#41](https://github.com/pleaseai/statusbeam/issues/41) ([#44](https://github.com/pleaseai/statusbeam/issues/44)) ([868792b](https://github.com/pleaseai/statusbeam/commit/868792bee4c7d56460dad07f40e8577967cf3555))


### Miscellaneous Chores

* restart versioning at 0.1.0 ([#73](https://github.com/pleaseai/statusbeam/issues/73)) ([d0ed3f8](https://github.com/pleaseai/statusbeam/commit/d0ed3f82fa43159ebc3481affcd9fc86f1ce6204))

## 0.1.0 (2026-07-31)


### Features

* add Sentry Uptime adapter (webhook + poll backstop) ([#53](https://github.com/pleaseai/statusbeam/issues/53)) ([e2970b1](https://github.com/pleaseai/statusbeam/commit/e2970b13be7f11ddb0ff3d246e4618b7acacc939))
* badges & public status API (shields.io endpoints) ([#20](https://github.com/pleaseai/statusbeam/issues/20)) ([ed229cd](https://github.com/pleaseai/statusbeam/commit/ed229cdfdbcc301217e031cc9b28145a97f1d946))
* close the cache-purge loop with shared Cache-Tag emit ([#10](https://github.com/pleaseai/statusbeam/issues/10)) ([193d3f9](https://github.com/pleaseai/statusbeam/commit/193d3f9c2a2ee2db5e9ba821c8462e63f5c20665))
* **core:** add Atlassian Statuspage check adapter ([#23](https://github.com/pleaseai/statusbeam/issues/23)) ([bf53f33](https://github.com/pleaseai/statusbeam/commit/bf53f337960883149cbfdcb600d800187c0fcadd))
* **core:** add incident.io status-page check adapter ([#39](https://github.com/pleaseai/statusbeam/issues/39)) ([2f1349c](https://github.com/pleaseai/statusbeam/commit/2f1349cf62122cb4b46df6963af1488eff0e4895))
* **i18n:** add English + CJK internationalization ([#18](https://github.com/pleaseai/statusbeam/issues/18)) ([2b85f7c](https://github.com/pleaseai/statusbeam/commit/2b85f7c345df366ef02af4809c057f0fddddd11b))
* incident timeline ([#7](https://github.com/pleaseai/statusbeam/issues/7)) ([6549a74](https://github.com/pleaseai/statusbeam/commit/6549a74771528c715a05c1a4e6f2f140efd0aa7d))
* package-based distribution (ADR-0002) ([#30](https://github.com/pleaseai/statusbeam/issues/30)) ([ae8b017](https://github.com/pleaseai/statusbeam/commit/ae8b0174276042cdc87dd0e2ec986643e79c26ab))
* scaffold monorepo (Astro web + Cron Worker + core) ([b1203f9](https://github.com/pleaseai/statusbeam/commit/b1203f9e18fb276c016f106da6edeaf7c046ec3b))
* **web:** add 90-day uptime timeline per component ([#6](https://github.com/pleaseai/statusbeam/issues/6)) ([a498f09](https://github.com/pleaseai/statusbeam/commit/a498f099406a52c433a43c3a0392294cf6d36dcf))
* **web:** add explicit dark mode theme toggle ([#24](https://github.com/pleaseai/statusbeam/issues/24)) ([5ab0d1a](https://github.com/pleaseai/statusbeam/commit/5ab0d1a3c59d12c96196a13e6121e13480018644))
* **web:** add RSS and Atom incident-history feeds ([#41](https://github.com/pleaseai/statusbeam/issues/41)) ([d4acb27](https://github.com/pleaseai/statusbeam/commit/d4acb27d7eb98736c4721061b951a64d4fe544f7))
* **web:** per-component response-time charts ([#9](https://github.com/pleaseai/statusbeam/issues/9)) ([41efdc7](https://github.com/pleaseai/statusbeam/commit/41efdc7e40d7f7ec3006a2f57c20aa3458326099))
* **worker:** ingest Atlassian Statuspage webhooks for real-time status ([#33](https://github.com/pleaseai/statusbeam/issues/33)) ([9f56c61](https://github.com/pleaseai/statusbeam/commit/9f56c61d4a89f5f5aee00af4bb4bee3d1b918256))
* **worker:** notify subscribers and purge edge cache on status change ([#8](https://github.com/pleaseai/statusbeam/issues/8)) ([8d4fee7](https://github.com/pleaseai/statusbeam/commit/8d4fee73c6af3a5efb7d947fd587a1d98015212c))
* **worker:** optional Cloudflare Queues path for reliable notification delivery ([#43](https://github.com/pleaseai/statusbeam/issues/43)) ([23ec7f3](https://github.com/pleaseai/statusbeam/commit/23ec7f317d1371f55339f5d7b136fda6aba04a1a))


### Bug Fixes

* **core:** address feed review findings from PR [#41](https://github.com/pleaseai/statusbeam/issues/41) ([#44](https://github.com/pleaseai/statusbeam/issues/44)) ([868792b](https://github.com/pleaseai/statusbeam/commit/868792bee4c7d56460dad07f40e8577967cf3555))
