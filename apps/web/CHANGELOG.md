# Changelog

## 0.1.0 (2026-07-31)


### Features

* badges & public status API (shields.io endpoints) ([#20](https://github.com/pleaseai/statusbeam/issues/20)) ([ed229cd](https://github.com/pleaseai/statusbeam/commit/ed229cdfdbcc301217e031cc9b28145a97f1d946))
* close the cache-purge loop with shared Cache-Tag emit ([#10](https://github.com/pleaseai/statusbeam/issues/10)) ([193d3f9](https://github.com/pleaseai/statusbeam/commit/193d3f9c2a2ee2db5e9ba821c8462e63f5c20665))
* host live demo at demo.status.pleaseai.dev ([a0d5583](https://github.com/pleaseai/statusbeam/commit/a0d5583ad71cb214413ed23af718b86e8cad2315))
* **i18n:** add English + CJK internationalization ([#18](https://github.com/pleaseai/statusbeam/issues/18)) ([2b85f7c](https://github.com/pleaseai/statusbeam/commit/2b85f7c345df366ef02af4809c057f0fddddd11b))
* incident timeline ([#7](https://github.com/pleaseai/statusbeam/issues/7)) ([6549a74](https://github.com/pleaseai/statusbeam/commit/6549a74771528c715a05c1a4e6f2f140efd0aa7d))
* package-based distribution (ADR-0002) ([#30](https://github.com/pleaseai/statusbeam/issues/30)) ([ae8b017](https://github.com/pleaseai/statusbeam/commit/ae8b0174276042cdc87dd0e2ec986643e79c26ab))
* scaffold monorepo (Astro web + Cron Worker + core) ([b1203f9](https://github.com/pleaseai/statusbeam/commit/b1203f9e18fb276c016f106da6edeaf7c046ec3b))
* **web:** add 90-day uptime timeline per component ([#6](https://github.com/pleaseai/statusbeam/issues/6)) ([a498f09](https://github.com/pleaseai/statusbeam/commit/a498f099406a52c433a43c3a0392294cf6d36dcf))
* **web:** add explicit dark mode theme toggle ([#24](https://github.com/pleaseai/statusbeam/issues/24)) ([5ab0d1a](https://github.com/pleaseai/statusbeam/commit/5ab0d1a3c59d12c96196a13e6121e13480018644))
* **web:** add RSS and Atom incident-history feeds ([#41](https://github.com/pleaseai/statusbeam/issues/41)) ([d4acb27](https://github.com/pleaseai/statusbeam/commit/d4acb27d7eb98736c4721061b951a64d4fe544f7))
* **web:** introduce shadcn/ui (Base UI) status components ([#4](https://github.com/pleaseai/statusbeam/issues/4)) ([347d971](https://github.com/pleaseai/statusbeam/commit/347d971717e847a3ebd2cffff71bf8c0c786b561))
* **web:** per-component response-time charts ([#9](https://github.com/pleaseai/statusbeam/issues/9)) ([41efdc7](https://github.com/pleaseai/statusbeam/commit/41efdc7e40d7f7ec3006a2f57c20aa3458326099))
* **web:** upgrade to Astro 7 ([47c516d](https://github.com/pleaseai/statusbeam/commit/47c516dd244665199da9c29abcf271a7215d1511))


### Bug Fixes

* **core:** address feed review findings from PR [#41](https://github.com/pleaseai/statusbeam/issues/41) ([#44](https://github.com/pleaseai/statusbeam/issues/44)) ([868792b](https://github.com/pleaseai/statusbeam/commit/868792bee4c7d56460dad07f40e8577967cf3555))
* **web:** make getLocale() KV read non-throwing (post-[#18](https://github.com/pleaseai/statusbeam/issues/18) review) ([#21](https://github.com/pleaseai/statusbeam/issues/21)) ([8119b86](https://github.com/pleaseai/statusbeam/commit/8119b862ac85f6d6e792592fdd148026c968f977))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @statusbeam/core bumped to 0.1.0
