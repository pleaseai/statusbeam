---
id: SPEC-001
level: V_M
domain: distribution
feature: emdash
depends: []
conflicts: []
traces: []
created_at: 2026-10-22T11:16:17.725Z
updated_at: 2026-10-29T02:17:29.230Z
source_tracks: ["emdash-distribution-20261022", "emdash-native-plugin-20261027"]
removed_by:
  - requirement: REQ-025
    track: "emdash-native-plugin-20261027"
    date: "2026-10-29"
---

# Emdash Specification

## Purpose

Emdash Specification 관련 요구사항.

## Requirements

### Requirement: measure how the plugin engine grades large (over 8 MiB), slow-body, and streaming HTTP responses in each of the three execution modes — the Cloudflare isolated runner, the Node isolated runner, and in-process — and record each result against the ADR-0004 probe contract
<!-- req: REQ-001 tracks=emdash-distribution-20261022 -->

The system MUST measure how the plugin engine grades large (over 8 MiB), slow-body, and streaming HTTP responses in each of the three execution modes — the Cloudflare isolated runner, the Node isolated runner, and in-process — and record each result against the ADR-0004 probe contract.

#### Scenario: When a monitored endpoint returns a body larger than 8 MiB, the spike shall record the graded result in each of the three execution modes.

- WHEN a monitored endpoint returns a body larger than 8 MiB
- THEN record the graded result in each of the three execution modes

#### Scenario: When a monitored endpoint streams its body slowly but completes under the size limit, the spike shall record the measured latency and graded status in each execution mode.

- WHEN a monitored endpoint streams its body slowly but completes under the size limit
- THEN record the measured latency and graded status in each execution mode

### Requirement: determine, in each execution mode, whether a probe rejected by a runtime limit (the body-size limit, the subrequest limit, or the CPU-time limit) can be told apart from a network failure or a target error
<!-- req: REQ-002 tracks=emdash-distribution-20261022 -->

The system MUST determine, in each execution mode, whether a probe rejected by a runtime limit (the body-size limit, the subrequest limit, or the CPU-time limit) can be told apart from a network failure or a target error.

### Requirement: measure how many monitors one scheduled run can probe on the Cloudflare isolated runner within its per-invocation limits (10 subrequests, 50 ms CPU, 30 s wall time), counting notification deliveries and the per-run configuration re-validation (FR-20) against the same limits, and decide whether a run must be split across invocations
<!-- req: REQ-003 tracks=emdash-distribution-20261022 -->

The system MUST measure how many monitors one scheduled run can probe on the Cloudflare isolated runner within its per-invocation limits (10 subrequests, 50 ms CPU, 30 s wall time), counting notification deliveries and the per-run configuration re-validation (FR-20) against the same limits, and decide whether a run must be split across invocations.

#### Scenario: When one scheduled run probes more monitors than the Cloudflare runner's subrequest limit allows, the spike shall record whether the run fails, truncates, or completes, and how many probes finished.

- WHEN one scheduled run probes more monitors than the Cloudflare runner's subrequest limit allows
- THEN record whether the run fails, truncates, or completes, and how many probes finished

### Requirement: confirm whether the plugin scheduler supports the current 5-minute check cadence
<!-- req: REQ-004 tracks=emdash-distribution-20261022 -->

The system MUST confirm whether the plugin scheduler supports the current 5-minute check cadence.

### Requirement: record the spike findings in ADR-0004, and either mark it Accepted or revise it and the affected later phases before engine work (Phase 3) starts
<!-- req: REQ-005 tracks=emdash-distribution-20261022 -->

The system MUST record the spike findings in ADR-0004, and either mark it Accepted or revise it and the affected later phases before engine work (Phase 3) starts.

#### Scenario: If any execution mode grades a probe differently from the ADR-0004 probe contract, then the track shall revise ADR-0004 before Phase 3 starts.

- WHEN any execution mode grades a probe differently from the ADR-0004 probe contract
- THEN revise ADR-0004 before Phase 3 starts

### Requirement: define the public status response (overall and per-site) as one shared, versioned contract that both standalone StatusBeam and the engine plugin produce and the render library consumes
<!-- req: REQ-006 tracks=emdash-distribution-20261022 -->

The system MUST define the public status response (overall and per-site) as one shared, versioned contract that both standalone StatusBeam and the engine plugin produce and the render library consumes.

### Requirement: serve the engine plugin's public status, per-site, and badge endpoints with unwrapped response bodies in the same shape as the standalone endpoints, at a documented path mapping from the standalone paths, in the core-owned public status contract (contract version 1, including the optional "not checked yet" flag)
<!-- req: REQ-007 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST serve the engine plugin's public status, per-site, and badge endpoints with unwrapped response bodies in the same shape as the standalone endpoints, at a documented path mapping from the standalone paths, in the core-owned public status contract (contract version 1, including the optional "not checked yet" flag).

#### Scenario: When a client requests the plugin's public status endpoint, the system shall return a body that the shared contract accepts with no wrapping envelope.

- WHEN a client requests the plugin's public status endpoint
- THEN return a body that the shared contract accepts with no wrapping envelope

#### Scenario: When a client requests the plugin's badge endpoint, the system shall return a body that is a valid shields.io endpoint response.

- WHEN a client requests the plugin's badge endpoint
- THEN return a body that is a valid shields.io endpoint response

#### Scenario: If a client requests the plugin's uptime badge with an invalid or absent `period`, then the system shall return the monthly uptime badge, as the standalone endpoint does.

- WHEN a client requests the plugin's uptime badge with an invalid or absent `period`
- THEN return the monthly uptime badge, as the standalone endpoint does

#### Scenario: When a client requests the public status route, the system shall return an unwrapped JSON body that parses with the core public status schema.

- WHEN a client requests the public status route
- THEN return an unwrapped JSON body that parses with the core public status schema

#### Scenario: When a monitor has never been checked, the system shall mark it "not checked yet" in the public status response instead of reporting an outage.

- GIVEN a monitor has never been checked
- WHEN the public status response is built
- THEN mark the monitor "not checked yet" instead of reporting an outage

### Requirement: run every configured poll monitor on its schedule from one native plugin in a single scheduled task, on a site that has no sandbox runner configured (webhook-only Sentry monitors take their status from inbound webhooks), and keep check history and the current status snapshot in plugin-owned storage
<!-- req: REQ-008 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST run every configured poll monitor on its schedule from one native plugin in a single scheduled task, on a site that has no sandbox runner configured (webhook-only Sentry monitors take their status from inbound webhooks), and keep check history and the current status snapshot in plugin-owned storage.

#### Scenario: When the plugin is installed on a site with no sandbox runner configured, the system shall load the plugin and run the scheduled checks.

- GIVEN no sandbox runner is configured
- WHEN the plugin is installed on a site
- THEN load the plugin and run the scheduled checks

#### Scenario: When 12 monitors are configured (more than one invocation of the current sandboxed engine can probe), the system shall check all 12 in each scheduled run.

- GIVEN 12 monitors are configured
- WHEN a scheduled run starts
- THEN check all 12 monitors in that run

#### Scenario: When a monitored endpoint has not finished its response within 10 seconds, the system shall grade that probe down and go on to the task's remaining monitors.

- WHEN a monitored endpoint has not finished its response within 10 seconds
- THEN grade that probe down and go on to the task's remaining monitors

### Requirement: compute 90-day per-day uptime from plugin storage with the same results as the standalone rollup for the same check history
<!-- req: REQ-009 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST compute 90-day per-day uptime from plugin storage with the same results as the standalone rollup for the same check history.

#### Scenario: When the same sequence of check results is recorded by the plugin and by a standalone deployment, the system shall report identical per-day uptime figures for the 90-day window.

- WHEN the same sequence of check results is recorded by the plugin and by a standalone deployment
- THEN report identical per-day uptime figures for the 90-day window

### Requirement: send Slack and generic-webhook notifications when a monitor's status changes, with every notification secret stored encrypted
<!-- req: REQ-010 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST send Slack and generic-webhook notifications when a monitor's status changes, with every notification secret stored encrypted.

#### Scenario: The system shall not send a stored secret's value (a notification secret or the inbound webhook secret) to the browser, in the admin page or any route response.

- THEN do not send a stored secret's value to the browser, in the admin page or any route response

### Requirement: accept Statuspage and Sentry inbound webhooks on public endpoints authenticated by a shared secret token, rejecting every request while no webhook secret is configured and comparing the supplied token in constant time
<!-- req: REQ-011 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST accept Statuspage and Sentry inbound webhooks on public endpoints authenticated by a shared secret token, rejecting every request while no webhook secret is configured and comparing the supplied token in constant time.

#### Scenario: If no webhook secret is configured, then the system shall reject every inbound webhook request.

- WHEN no webhook secret is configured
- THEN reject every inbound webhook request

#### Scenario: If an inbound webhook request carries a token that does not match the configured secret, then the system shall reject it without changing any monitor's status.

- WHEN an inbound webhook request carries a token that does not match the configured secret
- THEN reject it without changing any monitor's status

#### Scenario: If an inbound webhook arrives while no webhook secret is configured, then the system shall reject it without changing any monitor's status.

- GIVEN no webhook secret is configured
- WHEN an inbound webhook arrives
- THEN reject it without changing any monitor's status

#### Scenario: The system shall not send a stored secret's value (a notification secret or the inbound webhook secret) to the browser, in the admin page or any route response.

- THEN do not send a stored secret's value to the browser, in the admin page or any route response

### Requirement: show administrators a status overview of every monitor (current status, 90-day history, latest response time) and a dashboard widget summarizing overall status
<!-- req: REQ-012 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST show administrators a status overview of every monitor (current status, 90-day history, latest response time) and a dashboard widget summarizing overall status.

#### Scenario: When a monitor has not been checked yet, the status overview shall show "Not checked yet" for it, with no uptime figure, instead of "down" or "100%".

- GIVEN a monitor has not been checked yet
- WHEN the status overview is shown
- THEN show "Not checked yet" for the monitor, with no uptime figure, instead of "down" or "100%"

### Requirement: classify each check as up, degraded, or down with the same rules and latency measure (time to response headers) a standalone deployment uses
<!-- req: REQ-013 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST classify each check as up, degraded, or down with the same rules and latency measure (time to response headers) a standalone deployment uses.

#### Scenario: When a monitored URL sends its response headers quickly and then streams its body slowly, the system shall record latency up to the headers and shall not mark the monitor degraded because of the slow body.

- WHEN a monitored URL sends its response headers quickly and then streams its body slowly
- THEN record latency up to the headers
- THEN do not mark the monitor degraded because of the slow body

#### Scenario: When a monitored response body exceeds 8 MiB, the system shall classify the check by its status code and response time instead of marking it down.

- WHEN a monitored response body exceeds 8 MiB
- THEN classify the check by its status code and response time instead of marking it down

#### Scenario: If a monitored response never completes, then the system shall record that check as down when the plugin's per-check deadline expires and shall still check the remaining monitors in that run.

- WHEN a monitored response never completes
- THEN record that check as down when the per-check deadline expires
- THEN still check the remaining monitors in that run

### Requirement: store the monitor configuration as one YAML document validated by the same core schema as a standalone `status.config.yml`
<!-- req: REQ-014 tracks=emdash-distribution-20261022 -->

The system MUST store the monitor configuration as one YAML document validated by the same core schema as a standalone `status.config.yml`.

### Requirement: provide an administrator-only plugin admin page where an administrator lists, adds, edits, and removes monitors through a form for each monitor, validated by the core configuration schema and saved only when it is valid
<!-- req: REQ-015 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST provide an administrator-only plugin admin page where an administrator lists, adds, edits, and removes monitors through a form for each monitor, validated by the core configuration schema and saved only when it is valid.

#### Scenario: When an administrator saves a configuration that fails the core schema, the system shall show every validation issue with the path of the offending field.

- WHEN an administrator saves a configuration that fails the core schema
- THEN show every validation issue with the path of the offending field

#### Scenario: When an administrator saves a configuration that fails the core schema, the system shall keep the previously saved configuration.

- WHEN an administrator saves a configuration that fails the core schema
- THEN keep the previously saved configuration

#### Scenario: When an administrator saves a monitor with an invalid field (for example a URL that is not http or https), the system shall show the error next to that field and shall not save the change.

- WHEN an administrator saves a monitor with an invalid field
- THEN show the error next to that field
- THEN do not save the change

#### Scenario: If another administrator saved the configuration after this page loaded, then the system shall refuse the save and show the newer configuration.

- GIVEN another administrator saved the configuration after this page loaded
- WHEN the administrator saves
- THEN refuse the save and show the newer configuration

#### Scenario: When an administrator removes a monitor and saves, the system shall stop checking it from the next scheduled run.

- WHEN an administrator removes a monitor and saves
- THEN stop checking it from the next scheduled run

#### Scenario: If a user who is not an administrator requests the admin page or any of its actions, then the system shall refuse the request.

- WHEN a user who is not an administrator requests the admin page or any of its actions
- THEN refuse the request

### Requirement: provide a Validate action that checks the configuration without saving it
<!-- req: REQ-016 tracks=emdash-distribution-20261022 -->

The system MUST provide a Validate action that checks the configuration without saving it.

### Requirement: let an administrator run one monitor's check on demand from the admin page and see its graded status, latency, and response code without recording history or sending a notification
<!-- req: REQ-017 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST let an administrator run one monitor's check on demand from the admin page and see its graded status, latency, and response code without recording history or sending a notification.

#### Scenario: When an administrator tests a monitor, the system shall show its status, latency, and response code.

- WHEN an administrator tests a monitor
- THEN show its status, latency, and response code

#### Scenario: When an administrator tests a monitor, the system shall not record the result in history or send a notification.

- WHEN an administrator tests a monitor
- THEN do not record the result in history or send a notification

### Requirement: apply plugin-only validation rules on top of the core schema — rejecting configurations the plugin cannot run and warning about ones it can run only partially
<!-- req: REQ-018 tracks=emdash-distribution-20261022 -->

The system MUST apply plugin-only validation rules on top of the core schema — rejecting configurations the plugin cannot run and warning about ones it can run only partially.

#### Scenario: When a configuration sets notification delivery to queue, the system shall reject it as unsupported by the plugin.

- WHEN a configuration sets notification delivery to queue
- THEN reject it as unsupported by the plugin

#### Scenario: When a configuration includes a TCP or SSL monitor, the system shall save it and show a warning that the plugin checks it over HTTP.

- WHEN a configuration includes a TCP or SSL monitor
- THEN save it and show a warning that the plugin checks it over HTTP

#### Scenario: When a configuration includes a Sentry monitor with a poll backstop but no Sentry token is set, the system shall save it and show a warning that the backstop cannot run.

- WHEN a configuration includes a Sentry monitor with a poll backstop but no Sentry token is set
- THEN save it and show a warning that the backstop cannot run

#### Scenario: When a configuration has more monitors than the scheduled tasks of one run can probe together, the system shall save it and show a capacity warning.

- WHEN a configuration has more monitors than the scheduled tasks of one run can probe together
- THEN save it and show a capacity warning

### Requirement: keep secrets (the Sentry token, the inbound webhook secret, and the Slack and generic-webhook notification URLs) in encrypted plugin settings that are never returned to the browser, separate from the YAML document
<!-- req: REQ-019 tracks=emdash-distribution-20261022 -->

The system MUST keep secrets (the Sentry token, the inbound webhook secret, and the Slack and generic-webhook notification URLs) in encrypted plugin settings that are never returned to the browser, separate from the YAML document.

#### Scenario: When a configuration includes a Slack or generic-webhook URL in the YAML, the system shall reject it with an error that points to the encrypted notification settings.

- WHEN a configuration includes a Slack or generic-webhook URL in the YAML
- THEN reject it with an error that points to the encrypted notification settings

### Requirement: re-validate the stored configuration on every scheduled run before checking anything
<!-- req: REQ-020 tracks=emdash-distribution-20261022 -->

The system MUST re-validate the stored configuration on every scheduled run before checking anything.

#### Scenario: If the stored configuration fails validation during a scheduled run, then the system shall skip that run's checks without changing any monitor's status.

- WHEN the stored configuration fails validation during a scheduled run
- THEN skip that run's checks without changing any monitor's status

#### Scenario: If the stored configuration fails validation during a scheduled run, then the system shall show a persistent error on the admin page until a valid configuration is saved.

- WHEN the stored configuration fails validation during a scheduled run
- THEN show a persistent error on the admin page until a valid configuration is saved

### Requirement: provide status banner, 90-day uptime bar, and per-site detail components that a site imports into its own pages, reading the public status contract from a configurable base URL that points at either the engine plugin or a standalone deployment
<!-- req: REQ-021 tracks=emdash-distribution-20261022 -->

The system MUST provide status banner, 90-day uptime bar, and per-site detail components that a site imports into its own pages, reading the public status contract from a configurable base URL that points at either the engine plugin or a standalone deployment.

#### Scenario: When the render library's base URL points at a standalone StatusBeam deployment, the components shall render the same per-site status as the standalone page.

- WHEN the render library's base URL points at a standalone StatusBeam deployment
- THEN render the same per-site status as the standalone page

### Requirement: register the opt-in "statusbeam-status" content block from the same plugin, rendered with the same components, keeping the block's choice of status source (this plugin or a standalone deployment) and the site's allowlist of origins a block may read
<!-- req: REQ-022 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST register the opt-in "statusbeam-status" content block from the same plugin, rendered with the same components, keeping the block's choice of status source (this plugin or a standalone deployment) and the site's allowlist of origins a block may read.

#### Scenario: When an editor inserts the status block for a monitor and publishes the content, the published page shall show that monitor's current status.

- WHEN an editor inserts the status block for a monitor and publishes the content
- THEN the published page shows that monitor's current status

### Requirement: document installation and operation of both packages, installing the plugin as a trusted site dependency (a code and configuration change), including the unrestricted outbound network access the engine requests and the probe contract's limits, and state that a plugin-hosted status page goes down with the CMS it reports on
<!-- req: REQ-023 tracks=emdash-distribution-20261022,emdash-native-plugin-20261027 -->

The system MUST document installation and operation of both packages, installing the plugin as a trusted site dependency (a code and configuration change), including the unrestricted outbound network access the engine requests and the probe contract's limits, and state that a plugin-hosted status page goes down with the CMS it reports on.

#### Scenario: The installation guide shall state which deployment shape keeps checks and the status page independent of a CMS or host outage.

- THEN state which deployment shape keeps checks and the status page independent of a CMS or host outage

### Requirement: restrict the admin page, the dashboard widget, and every admin-only route to site administrators
<!-- req: REQ-029 tracks=emdash-native-plugin-20261027 -->

The system MUST restrict the admin page, the dashboard widget, and every admin-only route to site administrators.

#### Scenario: If a user who is not an administrator opens the admin page or calls an admin-only route, then the system shall refuse the request and reveal nothing about the configuration.

- WHEN a user who is not an administrator opens the admin page or calls an admin-only route
- THEN refuse the request and reveal nothing about the configuration

### Requirement: ship one engine implementation for EmDash, with no sandboxed engine entry, no Block Kit admin page, and no bridge-call sharding
<!-- req: REQ-030 tracks=emdash-native-plugin-20261027 -->

The system MUST ship one engine implementation for EmDash, with no sandboxed engine entry, no Block Kit admin page, and no bridge-call sharding.

#### Scenario: When the plugin package is installed, the system shall expose no sandboxed plugin entry for that package.

- WHEN the plugin package is installed
- THEN expose no sandboxed plugin entry for that package

### Requirement: record the native-plugin decision in ADR-0005 and mark ADR-0004 as superseded by it, without rewriting ADR-0004
<!-- req: REQ-031 tracks=emdash-native-plugin-20261027 -->

The system MUST record the native-plugin decision in ADR-0005 and mark ADR-0004 as superseded by it, without rewriting ADR-0004.

## Non-functional Requirements

### Requirement: keep the render library and the content block limited to the public status data — no scheduled work, no storage, and no access to engine state
<!-- req: REQ-024 tracks=emdash-distribution-20261022 -->

The system SHOULD keep the render library and the content block limited to the public status data — no scheduled work, no storage, and no access to engine state.

### Requirement: verify contract parity at the HTTP level, comparing the plugin's endpoint responses with the standalone endpoints rather than only the data before it is serialized
<!-- req: REQ-026 tracks=emdash-distribution-20261022 -->

The system SHOULD verify contract parity at the HTTP level, comparing the plugin's endpoint responses with the standalone endpoints rather than only the data before it is serialized.

### Requirement: convey status in the render library with a label or icon alongside color, using the existing severity tokens (WCAG 2.1 AA)
<!-- req: REQ-027 tracks=emdash-distribution-20261022 -->

The system SHOULD convey status in the render library with a label or icon alongside color, using the existing severity tokens (WCAG 2.1 AA).

### Requirement: reuse the core check engine and configuration schema without forking them
<!-- req: REQ-028 tracks=emdash-distribution-20261022 -->

The system SHOULD reuse the core check engine and configuration schema without forking them.

### Requirement: follow EmDash's admin rules for native React code (its component kit, localization, accessibility, and right-to-left layout), with StatusBeam's own strings available in every locale `@statusbeam/core` supports (en, zh, ja, ko) and English shown for any other admin locale
<!-- req: REQ-032 tracks=emdash-native-plugin-20261027 -->

The system SHOULD follow EmDash's admin rules for native React code (its component kit, localization, accessibility, and right-to-left layout), with StatusBeam's own strings available in every locale `@statusbeam/core` supports (en, zh, ja, ko) and English shown for any other admin locale.

### Requirement: cover the scheduled run, the public and webhook routes, and the admin routes with tests that execute the plugin the way an EmDash host loads a native plugin
<!-- req: REQ-033 tracks=emdash-native-plugin-20261027 -->

The system SHOULD cover the scheduled run, the public and webhook routes, and the admin routes with tests that execute the plugin the way an EmDash host loads a native plugin.

### Requirement: refuse every probe the plugin sends, scheduled or on demand, to a loopback, private, link-local, or cloud-metadata address, as the host's HTTP API does, whichever fetch path the check uses
<!-- req: REQ-034 tracks=emdash-native-plugin-20261027 -->

The system SHOULD refuse every probe the plugin sends, scheduled or on demand, to a loopback, private, link-local, or cloud-metadata address, as the host's HTTP API does, whichever fetch path the check uses.
