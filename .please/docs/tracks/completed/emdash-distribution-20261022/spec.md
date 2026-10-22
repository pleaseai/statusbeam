---
product_spec_domain: distribution/emdash
---

# EmDash distribution: sandboxed engine plugin + Astro render library

> Track: emdash-distribution-20261022

## Overview

StatusBeam gains a second distribution channel inside [EmDash](https://github.com/emdash-cms)
sites, as decided in ADR-0004 (`docs/adr/0004-emdash-plugin-distribution.md`,
Accepted after the Phase 1 spike). It ships as two packages with one check engine:

- **Engine plugin** — an EmDash plugin installed from the registry that runs scheduled checks,
  keeps history and the current snapshot, sends status-change notifications, serves the public
  status and badge endpoints, accepts Statuspage/Sentry webhooks, and offers an admin page for
  monitor configuration.
- **Render library** — a set of status-page components a site imports into its own pages. It
  is not a plugin. It reads the public status data from either the engine plugin or a
  standalone StatusBeam deployment. An opt-in entry point adds a "status" content block that
  editors can embed in posts; only that entry point registers with the host, as a trusted
  (native) plugin that adds the block and nothing else.

A **monitor** is one entry under `sites:` in the configuration; the public endpoints and
components keep the standalone "site" naming for the same thing.

The plugin runtime changes how HTTP probes behave (full-body buffering, a body-size limit, and
per-invocation resource limits on the Cloudflare runner). ADR-0004 cannot be accepted until a
spike shows those semantics hold, so **Phase 1 is that spike**, and its results decide whether
the later phases proceed as specified or the ADR is revised first.

Monitor configuration stays a single YAML document validated by the same core schema as
standalone StatusBeam, edited on a plugin admin page that validates before saving. Secrets and notification URLs live in encrypted settings instead of the YAML.

## Requirements

### Functional Requirements

**Phase 1 — probe-semantics spike (gates ADR-0004)**

- [ ] FR-1: measure how the plugin engine grades large (over 8 MiB), slow-body, and streaming HTTP responses in each of the three execution modes — the Cloudflare isolated runner, the Node isolated runner, and in-process — and record each result against the ADR-0004 probe contract
- [ ] FR-2: determine, in each execution mode, whether a probe rejected by a runtime limit (the body-size limit, the subrequest limit, or the CPU-time limit) can be told apart from a network failure or a target error
- [ ] FR-3: measure how many monitors one scheduled run can probe on the Cloudflare isolated runner within its per-invocation limits (10 subrequests, 50 ms CPU, 30 s wall time), counting notification deliveries and the per-run configuration re-validation (FR-20) against the same limits, and decide whether a run must be split across invocations
- [ ] FR-4: confirm whether the plugin scheduler supports the current 5-minute check cadence
- [ ] FR-5: record the spike findings in ADR-0004, and either mark it Accepted or revise it and the affected later phases before engine work (Phase 3) starts

**Phase 2 — shared public status contract**

- [ ] FR-6: define the public status response (overall and per-site) as one shared, versioned contract that both standalone StatusBeam and the engine plugin produce and the render library consumes
- [ ] FR-7: serve the engine plugin's public status, per-site, and badge endpoints with unwrapped response bodies in the same shape as the standalone endpoints, at a documented path mapping from the standalone paths

**Phase 3 — engine plugin**

- [ ] FR-8: run scheduled checks for every configured monitor inside the plugin, sharding each run's monitors across separate scheduled tasks so every task stays within one invocation's limits, and keep check history and the current status snapshot in plugin-owned storage
- [ ] FR-9: compute 90-day per-day uptime from plugin storage with the same results as the standalone rollup for the same check history
- [ ] FR-10: send Slack and generic-webhook notifications when a monitor's status changes
- [ ] FR-11: accept Statuspage and Sentry inbound webhooks on public endpoints authenticated by a shared secret token
- [ ] FR-12: show a current-status summary widget on the EmDash admin dashboard
- [ ] FR-13: record a probe whose response exceeds the body-size limit as unsupported, exclude it from status and uptime rollups and from notifications, and show a persistent warning on that monitor naming the limit; plan each scheduled task's calls before it starts so it never begins a probe it cannot afford, and leave every monitor unchanged when the runtime still ends a task early

**Phase 4 — monitor configuration**

- [ ] FR-14: store the monitor configuration as one YAML document validated by the same core schema as a standalone `status.config.yml`
- [ ] FR-15: provide an administrator-only plugin admin page to edit, validate, save, and test the configuration, saving only when it is valid
- [ ] FR-16: provide a Validate action that checks the configuration without saving it
- [ ] FR-17: provide a Test site action that runs one check for a single monitor and shows its graded result and latency without saving anything
- [ ] FR-18: apply plugin-only validation rules on top of the core schema — rejecting configurations the plugin cannot run and warning about ones it can run only partially
- [ ] FR-19: keep secrets (the Sentry token, the inbound webhook secret, and the Slack and generic-webhook notification URLs) in encrypted plugin settings that are never returned to the browser, separate from the YAML document
- [ ] FR-20: re-validate the stored configuration on every scheduled run before checking anything

**Phase 5 — render library and documentation**

- [ ] FR-21: provide status banner, 90-day uptime bar, and per-site detail components that a site imports into its own pages, reading the public status contract from a configurable base URL that points at either the engine plugin or a standalone deployment
- [ ] FR-22: provide an opt-in "status" content block that editors can insert into posts, rendered with the same components
- [ ] FR-23: document installation and operation of both packages, including the execution-mode requirements, the unrestricted outbound network access the engine requests, and the probe contract's limits

### Non-functional Requirements

- [ ] NFR-1: keep the render library and the content block limited to the public status data — no scheduled work, no storage, and no access to engine state
- [ ] NFR-2: keep every scheduled task within the Cloudflare runner's per-invocation limits, with no more monitors per task than FR-3 measured
- [ ] NFR-3: verify contract parity at the HTTP level, comparing the plugin's endpoint responses with the standalone endpoints rather than only the data before it is serialized
- [ ] NFR-4: convey status in the render library with a label or icon alongside color, using the existing severity tokens (WCAG 2.1 AA)
- [ ] NFR-5: reuse the core check engine and configuration schema without forking them

## Acceptance Criteria

- [ ] AC-001 (FR-1): When a monitored endpoint returns a body larger than 8 MiB, the spike shall record the graded result in each of the three execution modes.
- [ ] AC-002 (FR-1): When a monitored endpoint streams its body slowly but completes under the size limit, the spike shall record the measured latency and graded status in each execution mode.
- [ ] AC-003 (FR-3): When one scheduled run probes more monitors than the Cloudflare runner's subrequest limit allows, the spike shall record whether the run fails, truncates, or completes, and how many probes finished.
- [ ] AC-004 (FR-5): If any execution mode grades a probe differently from the ADR-0004 probe contract, then the track shall revise ADR-0004 before Phase 3 starts.
- [ ] AC-005 (FR-7): When a client requests the plugin's public status endpoint, the system shall return a body that the shared contract accepts with no wrapping envelope.
- [ ] AC-006 (FR-7): When a client requests the plugin's badge endpoint, the system shall return a body that is a valid shields.io endpoint response.
- [ ] AC-007 (FR-11): If no webhook secret is configured, then the system shall reject every inbound webhook request.
- [ ] AC-008 (FR-11): If an inbound webhook request carries a token that does not match the configured secret, then the system shall reject it without changing any monitor's status.
- [ ] AC-009 (FR-13): When a probe fails because the response exceeds the body-size limit, the system shall mark that probe unsupported.
- [ ] AC-010 (FR-13): The system shall assign each scheduled task no more monitors than its call budget covers, counting probes, notification deliveries, and storage calls.
- [ ] AC-011 (FR-13): If a probe is marked unsupported, then the system shall not send a status-change notification for that monitor.
- [ ] AC-012 (FR-13): If a probe is marked unsupported, or the runtime ends its scheduled task early, then the system shall leave that monitor's status and uptime unchanged.
- [ ] AC-013 (FR-13): The system shall not switch a monitor configured for GET to HEAD to stay under the body-size limit.
- [ ] AC-014 (FR-15): When an administrator saves a configuration that fails the core schema, the system shall show every validation issue with the path of the offending field.
- [ ] AC-015 (FR-15): When an administrator saves a configuration that fails the core schema, the system shall keep the previously saved configuration.
- [ ] AC-016 (FR-15): If the stored configuration changed after the administrator loaded the admin page, then the system shall refuse the save and tell the administrator to reload.
- [ ] AC-017 (FR-15): If a user who is not an administrator requests the admin page or any of its actions, then the system shall refuse the request.
- [ ] AC-018 (FR-18): When a configuration sets notification delivery to queue, the system shall reject it as unsupported by the plugin.
- [ ] AC-019 (FR-18): When a configuration includes a TCP or SSL monitor, the system shall save it and show a warning that the plugin checks it over HTTP.
- [ ] AC-020 (FR-18): When a configuration includes a Sentry monitor with a poll backstop but no Sentry token is set, the system shall save it and show a warning that the backstop cannot run.
- [ ] AC-021 (FR-18): When a configuration has more monitors than the scheduled tasks of one run can probe together, the system shall save it and show a capacity warning.
- [ ] AC-022 (FR-19): When a configuration includes a Slack or generic-webhook URL in the YAML, the system shall reject it with an error that points to the encrypted notification settings.
- [ ] AC-023 (FR-20): If the stored configuration fails validation during a scheduled run, then the system shall skip that run's checks without changing any monitor's status.
- [ ] AC-024 (FR-20): If the stored configuration fails validation during a scheduled run, then the system shall show a persistent error on the admin page until a valid configuration is saved.
- [ ] AC-025 (FR-17): When an administrator runs Test site for one monitor, the system shall show its graded status and latency.
- [ ] AC-026 (FR-17): The system shall not write check history or change any monitor's status when an administrator runs Test site.
- [ ] AC-027 (FR-21): When the render library's base URL points at a standalone StatusBeam deployment, the components shall render the same per-site status as the standalone page.
- [ ] AC-028 (FR-23): The installation guide shall state that the engine plugin needs a sandbox runner.
- [ ] AC-029 (FR-23): The installation guide shall state that running the engine plugin in-process is a trust decision that gives up isolation and resource limits.
- [ ] AC-030 (FR-23): The installation guide shall state which deployment shape keeps checks and the status page independent of a CMS or host outage.
- [ ] AC-031 (FR-8): When a monitored endpoint has not finished its response within 10 seconds, the system shall grade that probe down and go on to the task's remaining monitors.

## Out of Scope

- A React (native) configuration editor; the Block Kit admin page is the only editor in this track
- Real TCP and SSL probes; they remain HTTP fallbacks, and become standalone-only once they exist
- Instant cache purge parity with standalone; plugin endpoints rely on time-based caching
- Queue-based notification delivery in the plugin
- Migrating an existing standalone deployment's history into the plugin
- Submitting the engine plugin to the EmDash registry and publishing the packages; this track prepares them for release

## Assumptions

- ADR-0004 (as amended in #96 and #99) is the design baseline. Its Decision section, probe contract, and open questions are the source for the requirements above.
- The per-invocation limits in FR-3 are the fixed values on EmDash's Plugin Sandbox page (Cloudflare runner: 50 ms CPU, 10 subrequests, 30 s wall time; Node runner: 30 s wall time only).
- Phase 1 findings may change Phases 2–5. A finding that contradicts the probe contract or makes the cadence or capacity unworkable sends the track back to ADR-0004 before engine work, per AC-004.
- The configuration format decision is settled: one YAML document in plugin settings, edited on a plugin-owned admin page. The host's generated settings form is used only for secrets, because it offers no validation before save.
- Whether the engine plugin itself can declare the content block (removing the native entry point for plugin-engine sites) is an open question from ADR-0004. FR-22 keeps the native entry point until that is confirmed.
- Storage layout for 90 days of history (raw checks or per-day buckets) and same-site server-side fetching of plugin endpoints are open ADR-0004 questions for the plan to resolve; neither changes the requirements above.
- The spike has access to a Cloudflare account where the Worker Loader runner is available, plus a Node host for the workerd runner and the in-process mode.
- The two packages live as new workspaces in this monorepo under the existing release tooling.
