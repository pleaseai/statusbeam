---
product_spec_domain: emdash/plugin
---

# StatusBeam as a single native EmDash plugin with a React admin page

> Track: emdash-native-plugin-20261027

## Overview

Today StatusBeam reaches EmDash sites in two pieces (ADR-0004): a sandboxed engine plugin
with a Block Kit admin page where administrators edit the configuration as raw YAML, and
`@statusbeam/emdash-ui`, an Astro component library that also carries a separate native
plugin entry for the "status" Portable Text block.

Administrators need a real admin page: a form for each monitor instead of a YAML text
box, a status overview, and a way to test one monitor. EmDash allows a React admin page
only in a native plugin. Once a site has to install a native plugin, the two reasons
ADR-0004 gave for sandboxing the engine stop holding: install from the registry without
a code change, and an engine that does not run with the site's authority. The sandbox
would still cost us bridge-call sharding, latency measured to the last body byte, an
8 MiB body limit, and a required sandbox runner.

This track ports the engine, the admin page, and the Portable Text block into **one
native EmDash plugin**. `@statusbeam/emdash-ui` becomes a component library with no
plugin entry, and a new ADR (ADR-0005) supersedes ADR-0004. Neither package has been
published, so no site has data to migrate.

## Requirements

### Functional Requirements

- [ ] FR-1: run every configured monitor on its schedule from one native plugin, on a site that has no sandbox runner configured
- [ ] FR-2: classify each check as up, degraded, or down with the same rules and latency measure (time to response headers) a standalone deployment uses
- [ ] FR-3: record check history and the current snapshot, and produce the same per-day uptime figures a standalone deployment produces for the same check results
- [ ] FR-4: serve the public status, per-site status, and badge responses in the core-owned public status contract (contract version 1, including the optional "not checked yet" flag)
- [ ] FR-5: accept inbound Statuspage and Sentry webhooks, rejecting every request while no webhook secret is configured and comparing the supplied token in constant time
- [ ] FR-6: send Slack and generic webhook notifications on a status change, with every notification secret stored encrypted
- [ ] FR-7: let an administrator list, add, edit, and remove monitors through a form for each monitor, validated by the core configuration schema before anything is saved
- [ ] FR-8: show administrators a status overview of every monitor (current status, 90-day history, latest response time) and a dashboard widget summarizing overall status
- [ ] FR-9: let an administrator run one monitor's check on demand from the admin page and see its result
- [ ] FR-10: restrict the admin page, the dashboard widget, and every admin-only route to site administrators
- [ ] FR-11: register the "statusbeam-status" Portable Text block from the same plugin, so editors can embed a monitor's status in content, keeping the block's choice of status source (this plugin or a standalone deployment) and the site's allowlist of origins a block may read
- [ ] FR-12: remove the sandboxed engine entry, its Block Kit admin page, and the bridge-call sharding, leaving one engine implementation for EmDash
- [ ] FR-13: record the decision in ADR-0005 and mark ADR-0004 as superseded by it, without rewriting ADR-0004

### Non-functional Requirements

- [ ] NFR-1: follow EmDash's admin rules for native React code (its component kit, localization, accessibility, and right-to-left layout), with StatusBeam's own strings available in every locale `@statusbeam/core` supports (en, zh, ja, ko) and English shown for any other admin locale
- [ ] NFR-2: cover the scheduled run, the public and webhook routes, and the admin routes with tests that execute the plugin the way an EmDash host loads a native plugin
- [ ] NFR-3: document installation as a trusted site dependency (a code and configuration change), and state that a plugin-hosted status page goes down with the CMS it reports on
- [ ] NFR-4: refuse every probe the plugin sends, scheduled or on demand, to a loopback, private, link-local, or cloud-metadata address, as the host's HTTP API does today, whichever fetch path FR-2 uses

## Acceptance Criteria

- [ ] AC-001 (FR-1): When the plugin is installed on a site with no sandbox runner configured, the system shall load the plugin and run the scheduled checks.
- [ ] AC-002 (FR-1): When 12 monitors are configured (more than one invocation of the current sandboxed engine can probe), the system shall check all 12 in each scheduled run.
- [ ] AC-003 (FR-2): When a monitored URL sends its response headers quickly and then streams its body slowly, the system shall record latency up to the headers and shall not mark the monitor degraded because of the slow body.
- [ ] AC-004 (FR-2): When a monitored response body exceeds 8 MiB, the system shall classify the check by its status code and response time instead of marking it down.
- [ ] AC-005 (FR-2): If a monitored response never completes, then the system shall record that check as down when the plugin's per-check deadline expires and shall still check the remaining monitors in that run.
- [ ] AC-006 (FR-3): When the same sequence of check results is recorded by the plugin and by a standalone deployment, the system shall report identical per-day uptime figures for the 90-day window.
- [ ] AC-007 (FR-4): When a client requests the public status route, the system shall return an unwrapped JSON body that parses with the core public status schema.
- [ ] AC-008 (FR-4): When a monitor has never been checked, the system shall mark it "not checked yet" in the public status response instead of reporting an outage.
- [ ] AC-009 (FR-5): If an inbound webhook arrives while no webhook secret is configured, then the system shall reject it without changing any monitor's status.
- [ ] AC-010 (FR-5, FR-6): The system shall not send a stored secret's value (a notification secret or the inbound webhook secret) to the browser, in the admin page or any route response.
- [ ] AC-011 (FR-7): When an administrator saves a monitor with an invalid field (for example a URL that is not http or https), the system shall show the error next to that field and shall not save the change.
- [ ] AC-012 (FR-7): If another administrator saved the configuration after this page loaded, then the system shall refuse the save and show the newer configuration.
- [ ] AC-013 (FR-7): When an administrator removes a monitor and saves, the system shall stop checking it from the next scheduled run.
- [ ] AC-014 (FR-8): When a monitor has not been checked yet, the status overview shall show "Not checked yet" for it, with no uptime figure, instead of "down" or "100%".
- [ ] AC-015 (FR-9): When an administrator tests a monitor, the system shall show its status, latency, and response code.
- [ ] AC-016 (FR-10): If a user who is not an administrator opens the admin page or calls an admin-only route, then the system shall refuse the request and reveal nothing about the configuration.
- [ ] AC-017 (FR-11): When an editor inserts the status block for a monitor and publishes the content, the published page shall show that monitor's current status.
- [ ] AC-018 (FR-12): When the plugin package is installed, the system shall expose no sandboxed plugin entry for that package.
- [ ] AC-019 (FR-9): When an administrator tests a monitor, the system shall not record the result in history or send a notification.

## Out of Scope

- An incident admin panel and incident create/update/resolve (#63)
- Listing the plugin in the EmDash registry
- Admin-editable overrides for the standalone Worker (#72)
- Publishing `@statusbeam/*` packages to npm (release pipeline)
- A YAML import/export view on the admin page
- Any change to the standalone `apps/worker` and `apps/web` deployments, beyond shared core code they already use

## Assumptions

- The sandboxed engine entry is removed rather than kept as a legacy entry. The request names a single plugin, and with nothing published no site depends on the sandboxed form.
- A native plugin can measure latency to the response headers without buffering the body. The host's HTTP API does not: ADR-0004's 2026-10-22 spike measured it buffering the whole body in every execution mode, in-process included, and blocking on a response that never completes. The platform's own fetch is the remaining path, and ADR-0004 did not test it. The plan starts with a spike; if that path does not work, FR-2 and AC-003 to AC-005 go back to the user before implementation.
- Native plugins get the same storage, KV, and settings APIs as sandboxed plugins (EmDash documents them as identical), so check history and the snapshot can keep their current shape.
- Monitor configuration stays expressible as a `status.config.yml` document validated by core, so the standalone and plugin channels keep one schema even without an import/export view.
