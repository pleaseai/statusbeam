---
id: SPEC-001
level: V_M
domain: distribution
feature: emdash
depends: []
conflicts: []
traces: []
created_at: 2026-10-22T11:16:17.725Z
updated_at: 2026-10-22T11:33:21.358Z
source_tracks: ["emdash-distribution-20261022"]
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

### Requirement: serve the engine plugin's public status, per-site, and badge endpoints with unwrapped response bodies in the same shape as the standalone endpoints, at a documented path mapping from the standalone paths
<!-- req: REQ-007 tracks=emdash-distribution-20261022 -->

The system MUST serve the engine plugin's public status, per-site, and badge endpoints with unwrapped response bodies in the same shape as the standalone endpoints, at a documented path mapping from the standalone paths.

#### Scenario: When a client requests the plugin's public status endpoint, the system shall return a body that the shared contract accepts with no wrapping envelope.

- WHEN a client requests the plugin's public status endpoint
- THEN return a body that the shared contract accepts with no wrapping envelope

#### Scenario: When a client requests the plugin's badge endpoint, the system shall return a body that is a valid shields.io endpoint response.

- WHEN a client requests the plugin's badge endpoint
- THEN return a body that is a valid shields.io endpoint response

#### Scenario: If a client requests the plugin's uptime badge with an invalid or absent `period`, then the system shall return the monthly uptime badge, as the standalone endpoint does.

- WHEN a client requests the plugin's uptime badge with an invalid or absent `period`
- THEN return the monthly uptime badge, as the standalone endpoint does

### Requirement: run scheduled checks inside the plugin for every configured poll monitor within the plugin's scheduled capacity (webhook-only Sentry monitors take their status from inbound webhooks, and monitors beyond capacity are named by the AC-021 warning), sharding each run's monitors across separate scheduled tasks so every task stays within one invocation's limits, and keep check history and the current status snapshot in plugin-owned storage
<!-- req: REQ-008 tracks=emdash-distribution-20261022 -->

The system MUST run scheduled checks inside the plugin for every configured poll monitor within the plugin's scheduled capacity (webhook-only Sentry monitors take their status from inbound webhooks, and monitors beyond capacity are named by the AC-021 warning), sharding each run's monitors across separate scheduled tasks so every task stays within one invocation's limits, and keep check history and the current status snapshot in plugin-owned storage.

#### Scenario: When a monitored endpoint has not finished its response within 10 seconds, the system shall grade that probe down and go on to the task's remaining monitors.

- WHEN a monitored endpoint has not finished its response within 10 seconds
- THEN grade that probe down and go on to the task's remaining monitors

### Requirement: compute 90-day per-day uptime from plugin storage with the same results as the standalone rollup for the same check history
<!-- req: REQ-009 tracks=emdash-distribution-20261022 -->

The system MUST compute 90-day per-day uptime from plugin storage with the same results as the standalone rollup for the same check history.

### Requirement: send Slack and generic-webhook notifications when a monitor's status changes
<!-- req: REQ-010 tracks=emdash-distribution-20261022 -->

The system MUST send Slack and generic-webhook notifications when a monitor's status changes.

### Requirement: accept Statuspage and Sentry inbound webhooks on public endpoints authenticated by a shared secret token
<!-- req: REQ-011 tracks=emdash-distribution-20261022 -->

The system MUST accept Statuspage and Sentry inbound webhooks on public endpoints authenticated by a shared secret token.

#### Scenario: If no webhook secret is configured, then the system shall reject every inbound webhook request.

- WHEN no webhook secret is configured
- THEN reject every inbound webhook request

#### Scenario: If an inbound webhook request carries a token that does not match the configured secret, then the system shall reject it without changing any monitor's status.

- WHEN an inbound webhook request carries a token that does not match the configured secret
- THEN reject it without changing any monitor's status

### Requirement: show a current-status summary widget on the EmDash admin dashboard
<!-- req: REQ-012 tracks=emdash-distribution-20261022 -->

The system MUST show a current-status summary widget on the EmDash admin dashboard.

### Requirement: record a probe whose response exceeds the body-size limit as unsupported, exclude it from status and uptime rollups and from notifications, and show a persistent warning on that monitor naming the limit; plan each scheduled task's calls before it starts so it never begins a probe it cannot afford, and leave every monitor unchanged when the runtime still ends a task early
<!-- req: REQ-013 tracks=emdash-distribution-20261022 -->

The system MUST record a probe whose response exceeds the body-size limit as unsupported, exclude it from status and uptime rollups and from notifications, and show a persistent warning on that monitor naming the limit; plan each scheduled task's calls before it starts so it never begins a probe it cannot afford, and leave every monitor unchanged when the runtime still ends a task early.

#### Scenario: When a probe fails because the response exceeds the body-size limit, the system shall mark that probe unsupported.

- WHEN a probe fails because the response exceeds the body-size limit
- THEN mark that probe unsupported

#### Scenario: The system shall assign each scheduled task no more monitors than its call budget covers, counting probes, notification deliveries, and storage calls.

- THEN assign each scheduled task no more monitors than its call budget covers, counting probes, notification deliveries, and storage calls

#### Scenario: If a probe is marked unsupported, then the system shall not send a status-change notification for that monitor.

- WHEN a probe is marked unsupported
- THEN the system shall not send a status-change notification for that monitor

#### Scenario: If a probe is marked unsupported, or the runtime ends its scheduled task early, then the system shall leave that monitor's status and uptime unchanged.

- WHEN a probe is marked unsupported, or the runtime ends its scheduled task early
- THEN leave that monitor's status and uptime unchanged

#### Scenario: The system shall not switch a monitor configured for GET to HEAD to stay under the body-size limit.

- THEN the system shall not switch a monitor configured for GET to HEAD to stay under the body-size limit

### Requirement: store the monitor configuration as one YAML document validated by the same core schema as a standalone `status.config.yml`
<!-- req: REQ-014 tracks=emdash-distribution-20261022 -->

The system MUST store the monitor configuration as one YAML document validated by the same core schema as a standalone `status.config.yml`.

### Requirement: provide an administrator-only plugin admin page to edit, validate, save, and test the configuration, saving only when it is valid
<!-- req: REQ-015 tracks=emdash-distribution-20261022 -->

The system MUST provide an administrator-only plugin admin page to edit, validate, save, and test the configuration, saving only when it is valid.

#### Scenario: When an administrator saves a configuration that fails the core schema, the system shall show every validation issue with the path of the offending field.

- WHEN an administrator saves a configuration that fails the core schema
- THEN show every validation issue with the path of the offending field

#### Scenario: When an administrator saves a configuration that fails the core schema, the system shall keep the previously saved configuration.

- WHEN an administrator saves a configuration that fails the core schema
- THEN keep the previously saved configuration

#### Scenario: If the stored configuration changed after the administrator loaded the admin page, then the system shall refuse the save and tell the administrator to reload.

- WHEN the stored configuration changed after the administrator loaded the admin page
- THEN refuse the save and tell the administrator to reload

#### Scenario: If a user who is not an administrator requests the admin page or any of its actions, then the system shall refuse the request.

- WHEN a user who is not an administrator requests the admin page or any of its actions
- THEN refuse the request

### Requirement: provide a Validate action that checks the configuration without saving it
<!-- req: REQ-016 tracks=emdash-distribution-20261022 -->

The system MUST provide a Validate action that checks the configuration without saving it.

### Requirement: provide a Test site action that runs one check for a single monitor and shows its graded result and latency without saving anything
<!-- req: REQ-017 tracks=emdash-distribution-20261022 -->

The system MUST provide a Test site action that runs one check for a single monitor and shows its graded result and latency without saving anything.

#### Scenario: When an administrator runs Test site for one monitor, the system shall show its graded status and latency.

- WHEN an administrator runs Test site for one monitor
- THEN show its graded status and latency

#### Scenario: The system shall not write check history or change any monitor's status when an administrator runs Test site.

- THEN the system shall not write check history or change any monitor's status when an administrator runs Test site

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

### Requirement: provide an opt-in "status" content block that editors can insert into posts, rendered with the same components
<!-- req: REQ-022 tracks=emdash-distribution-20261022 -->

The system MUST provide an opt-in "status" content block that editors can insert into posts, rendered with the same components.

### Requirement: document installation and operation of both packages, including the execution-mode requirements, the unrestricted outbound network access the engine requests, and the probe contract's limits
<!-- req: REQ-023 tracks=emdash-distribution-20261022 -->

The system MUST document installation and operation of both packages, including the execution-mode requirements, the unrestricted outbound network access the engine requests, and the probe contract's limits.

#### Scenario: The installation guide shall state that the engine plugin needs a sandbox runner.

- THEN state that the engine plugin needs a sandbox runner

#### Scenario: The installation guide shall state that running the engine plugin in-process is a trust decision that gives up isolation and resource limits.

- THEN state that running the engine plugin in-process is a trust decision that gives up isolation and resource limits

#### Scenario: The installation guide shall state which deployment shape keeps checks and the status page independent of a CMS or host outage.

- THEN state which deployment shape keeps checks and the status page independent of a CMS or host outage

## Non-functional Requirements

### Requirement: keep the render library and the content block limited to the public status data — no scheduled work, no storage, and no access to engine state
<!-- req: REQ-024 tracks=emdash-distribution-20261022 -->

The system SHOULD keep the render library and the content block limited to the public status data — no scheduled work, no storage, and no access to engine state.

### Requirement: keep every scheduled task within the Cloudflare runner's per-invocation limits, with no more monitors per task than FR-3 measured
<!-- req: REQ-025 tracks=emdash-distribution-20261022 -->

The system SHOULD keep every scheduled task within the Cloudflare runner's per-invocation limits, with no more monitors per task than FR-3 measured.

### Requirement: verify contract parity at the HTTP level, comparing the plugin's endpoint responses with the standalone endpoints rather than only the data before it is serialized
<!-- req: REQ-026 tracks=emdash-distribution-20261022 -->

The system SHOULD verify contract parity at the HTTP level, comparing the plugin's endpoint responses with the standalone endpoints rather than only the data before it is serialized.

### Requirement: convey status in the render library with a label or icon alongside color, using the existing severity tokens (WCAG 2.1 AA)
<!-- req: REQ-027 tracks=emdash-distribution-20261022 -->

The system SHOULD convey status in the render library with a label or icon alongside color, using the existing severity tokens (WCAG 2.1 AA).

### Requirement: reuse the core check engine and configuration schema without forking them
<!-- req: REQ-028 tracks=emdash-distribution-20261022 -->

The system SHOULD reuse the core check engine and configuration schema without forking them.
