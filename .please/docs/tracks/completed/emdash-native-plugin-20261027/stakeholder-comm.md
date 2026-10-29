## Resolution report

Hello. The work requested in issue #110 is done and ready for review.

**What the problem was**: StatusBeam for EmDash ran as a sandboxed plugin, and the sandbox limited it:
- A large status page had to be checked in several batches.
- Response times were measured to the last byte instead of the first response.
- Pages over 8 MiB could not be checked at all.
- The settings screen was a single YAML text box.

**How it was solved**: StatusBeam now installs on an EmDash site as one plugin. It checks every monitor in a single run every five minutes and measures response time the same way the standalone version does. It also adds three admin views:
- a monitor editor that points at the exact field to fix and can test one monitor on demand
- a status overview page
- a dashboard widget

The Status block for posts and pages is included in the same package.

**How to check it / what to expect**:
1. Add `statusbeam()` to the site's `plugins` list.
2. Open **Plugins → Monitors** in the EmDash admin to add monitors.
3. Open **Plugins → Status** to see each monitor's status and its 90-day history.

One plugin supports up to 200 monitors. Larger setups should use a standalone StatusBeam deployment.

**Release status**: PR #111 is in review. It ships once the PR is merged and released.

Thank you for the request. Please tell us if you run into anything else.
