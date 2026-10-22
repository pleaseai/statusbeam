## Resolution Report

Hello. The EmDash distribution requested in #100 is now implemented and ready for review.

**What was requested**: a way to run StatusBeam inside an EmDash site. Checks and the status page would run in the CMS, and the status components would be usable on any EmDash page.

**What we built**: two new packages.

- **`@statusbeam/emdash-plugin`** runs your monitors on a schedule inside EmDash's plugin sandbox. It:
  - keeps 90 days of history;
  - sends Slack and webhook alerts when a monitor's status changes;
  - serves the same status and badge endpoints as a standalone StatusBeam deployment;
  - accepts Statuspage and Sentry webhooks;
  - adds an administrator-only page to edit and validate the monitor configuration.
- **`@statusbeam/emdash-ui`** has drop-in status components: a banner, 90-day uptime bars and per-site detail. They can read the plugin or a standalone deployment. An optional "status" block lets editors embed the status in posts.

**What to expect**:
- Installation and operation are covered in the docs under Guides → EmDash.
- The plugin needs an EmDash sandbox runner.
- Each check has a 10-second limit and an 8 MiB response limit.
- With Slack notifications on, about 32 monitors can be checked every five minutes. Larger setups should use the standalone deployment.
- If your status page must stay up while your CMS is down, point the components at a standalone deployment instead of the plugin.

**Release status**: PR #101 is in review. The packages are published after it merges, in the same release as the updated `@statusbeam/core`.

Thank you for the request. Let us know if anything doesn't work as described.
