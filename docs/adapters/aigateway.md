# AI Gateway adapter

Track a **model endpoint's health** as published by the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) or
[OpenRouter](https://openrouter.ai/docs). Both gateways route production traffic
to the providers serving a model — Anthropic direct, Amazon Bedrock, Google
Vertex, Azure … — and publish the uptime and latency they observe doing it.
StatusBeam reads that telemetry and grades it like any other check.

## What it measures — and what it doesn't

This adapter reports the **gateway's own production telemetry** for a model. It
does **not**:

- **send probe traffic to the model.** No completion request is made, so the
  check spends **no tokens** and costs nothing.
- **measure your own path to the model.** The numbers are what the gateway sees
  from its infrastructure, aggregated across all of its traffic — not what your
  application sees.
- **need credentials.** Both endpoints are public; no API key is configured, and
  none is sent.

For a service you want to probe yourself, a plain
[`http`](../../README.md#check-types) check is the right tool.

## When to use it

- You depend on a model through one of these gateways and want its health on your
  status page next to your own services.
- You want to show which provider endpoint (Bedrock, Vertex, Anthropic direct) is
  degrading, rather than a single opaque "AI is slow".

## Configuration

```yaml
sites:
  # Grade the whole model: every endpoint the gateway routes to is graded and
  # the best one wins (the gateway routes around a failing provider).
  - name: Claude Opus 4.5
    check: aigateway
    aigateway:
      provider: vercel # vercel | openrouter
      model: anthropic/claude-opus-4.5 # creator/model

  # Track one provider endpoint of a model, with custom thresholds.
  - name: Claude Opus 4.5 (Bedrock)
    check: aigateway
    aigateway:
      provider: openrouter
      model: anthropic/claude-opus-4.5
      endpoint: amazon-bedrock # tag, provider name, or full endpoint name
      degradedUptime: 99 # published uptime % below this ⇒ degraded
      downUptime: 50 # published uptime % below this ⇒ down
    maxResponseTime: 3000 # published p50 above this (ms) ⇒ degraded
```

| Field                      | Required | Meaning                                                                                                          |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `check`                    | yes      | Must be `aigateway`.                                                                                              |
| `name`                     | yes      | Display name on your status page.                                                                                |
| `aigateway`                | yes      | The gateway/model block. Required for this kind, and rejected on any other kind.                                 |
| `aigateway.provider`       | yes      | `vercel` or `openrouter`.                                                                                        |
| `aigateway.model`          | yes      | Model id in `creator/model` form, e.g. `anthropic/claude-opus-4.5`.                                              |
| `aigateway.endpoint`       | no       | Track one provider endpoint. Matched case-insensitively against `tag`, then `provider_name`, then the full `name`. When omitted, the whole model is graded. |
| `aigateway.degradedUptime` | no       | Published uptime percentage below which the endpoint is `degraded`. Default `99`.                                 |
| `aigateway.downUptime`     | no       | Published uptime percentage below which the endpoint is `down`. Default `50`. Must be ≤ `degradedUptime`.        |
| `url`                      | no       | Omit it; the endpoints URL is derived from `provider` + `model`. A `url` set here is accepted but unused. |
| `maxResponseTime`          | no       | The published p50 above this (ms) marks the site `degraded`. Default `5000`.                                     |

`expectedStatusCodes` is ignored — the verdict comes from the payload, not from
the HTTP status of the API call.

## Finding an endpoint name

Both gateways serve the endpoint list unauthenticated, so you can read it with
`curl` and pick the endpoint you want to track:

```bash
# Vercel AI Gateway — match on `provider_name` (e.g. anthropic, bedrock, vertexAnthropic)
curl -s https://ai-gateway.vercel.sh/v1/models/anthropic/claude-opus-4.5/endpoints \
  | jq '.data.endpoints[] | {name, provider_name, status, uptime_last_1h, latency_last_1h}'

# OpenRouter — prefer `tag`; it is unique, while `provider_name` can repeat
curl -s https://openrouter.ai/api/v1/models/anthropic/claude-opus-4.5/endpoints \
  | jq '.data.endpoints[] | {name, provider_name, tag, status, uptime_last_30m}'
```

On OpenRouter the same `provider_name` may appear several times with different
`tag`s (`amazon-bedrock` vs `amazon-bedrock/eu-west-1`, `google-vertex/global`
vs `google-vertex/us-central1`), which is why `tag` is matched first — matching
on `provider_name` there picks whichever region is listed first. Vercel publishes
no `tag`; use `provider_name`.

## How the verdict is derived

Rules are applied in this order; the first match wins, so `down` beats `degraded`
beats `up`:

| Condition                                                   | Status     |
| ----------------------------------------------------------- | ---------- |
| Published uptime < `downUptime`                             | `down`     |
| Published uptime < `degradedUptime`                         | `degraded` |
| Endpoint `status` is any non-zero value (deranked, disabled, or unrecognized) | `degraded` |
| Published p50 latency > `maxResponseTime`                   | `degraded` |
| Otherwise                                                   | `up`       |

**Uptime is the primary signal.** It is the one number both gateways document and
publish consistently. The `status` integer is **undocumented** — `0` is the only
value observed to mean healthy, with `-2` and `-5` seen in the wild for a
deranked or disabled endpoint. Any non-zero value is therefore read as a
degradation signal: an unrecognized code is not evidence of health, and a status
page should not report a state it cannot interpret as operational. It only ever
yields `degraded` — never `down` on its own, since its severity is unknown.

When the gateway published **no uptime sample** for any window, that is silence
rather than a verdict: the check falls through to the `status` and latency rules
instead of inventing one.

**Whole-model mode.** Without `aigateway.endpoint`, every endpoint is graded and
the **best** one is the model's verdict. That is the honest model-level signal:
the gateway routes around a failing provider, so one bad endpoint is not an
outage of the model. `responseTime` comes from the endpoint that won — and among
endpoints tied at the best status, one that published a latency sample is
preferred, since gateways list idle endpoints with null telemetry alongside busy
ones.

## Aggregation windows differ per gateway

The two gateways aggregate over **different windows**. StatusBeam reads each
gateway's headline aggregate first — the same window its latency figure covers,
so one check describes one time slice — and falls back to a shorter window, then
to `1d`, only when the gateway published `null` there (routine for a low-traffic
endpoint, which has usually nulled the shorter window too):

| Provider     | Uptime windows (in order) | Latency window |
| ------------ | ------------------------- | -------------- |
| `vercel`     | `1h` → `15m` → `1d`       | `1h`           |
| `openrouter` | `30m` → `5m` → `1d`       | `30m`          |

> **The two providers' numbers are not directly comparable.** A Vercel site is
> graded on an hourly average and an OpenRouter site on a half-hourly one, so the
> same real incident shows up with different magnitude and lag on each. Don't
> read a difference between two sites on different gateways as a difference
> between the providers.

## Latency caveat

`responseTime` for this check is the **gateway's published p50** for the model —
not the round-trip of the API call StatusBeam makes. Timing the gateway's own
metrics endpoint would say nothing about the model.

**OpenRouter currently publishes `null` for `latency_last_30m` on every public
response we have sampled.** When no latency is published, `responseTime` is `0`
and latency plays no part in the verdict — so an OpenRouter site's response-time
graph stays flat at zero, and `maxResponseTime` has no effect there. Vercel does
publish `{ p50, p95 }`, and its p50 is used.

## Failure & edge behavior

Every outcome below produces a normal `CheckResult`, so it flows into the D1
time-series, KV snapshot, badges, and notifications like any other check.

| Situation                                    | `status` | `code`              | `responseTime` | `error`                                          |
| -------------------------------------------- | -------- | ------------------- | -------------- | ------------------------------------------------ |
| Endpoint(s) graded                           | derived  | `200`               | published p50 (`0` when none) | —                                 |
| Model unknown to the gateway                 | `down`   | `404`               | `0`            | `AI Gateway API returned 404`                    |
| Gateway API returns any other non-2xx        | `down`   | actual              | `0`            | `AI Gateway API returned …`                      |
| Body isn't the expected JSON shape           | `down`   | `200`               | `0`            | `AI Gateway endpoints payload failed validation …` |
| `aigateway.endpoint` matches nothing         | `down`   | `200`               | `0`            | `AI Gateway endpoint not found: …`               |
| The model publishes an empty endpoint list   | `down`   | `200`               | `0`            | `AI Gateway model publishes no endpoints: …`     |
| `aigateway` block missing (shouldn't parse)  | `down`   | `0`                 | `0`            | `AI Gateway check not configured …`              |
| Request never completes (DNS/TLS/timeout)    | `down`   | `0`                 | `0`            | the thrown error message                         |

`responseTime` is `0` on **every** failure path: this check reports the
gateway's published model latency, and a failed check has none. Timing the
gateway's own API instead would inject its round-trip into a series that
otherwise holds model latencies — the check history persists a response time for
`down` results too.

As with the Statuspage and Sentry adapters, `code` reflects whether the HTTP
request completed: a payload/config problem is deterministic and keeps the real
status code, while a genuine network outage records `code: 0`.

## Notes & limitations

- **No webhooks.** Neither gateway pushes health events, so this adapter is
  cron-polled only.
- **Shared telemetry, not yours.** A healthy verdict means the gateway is serving
  the model well *in aggregate*; your own key, region, or rate limits can still
  fail while this reads `up`.
- **Undocumented `status`.** Its exact codes aren't published, so only `0` is
  read as healthy and every other value is treated as a degradation signal only.
  If the gateways document them later, the mapping can be tightened — a code
  that turns out to mean "healthy" would currently show as `degraded`.
- **Incidents aren't ingested.** Only current health is read.

## How it fits together

The adapter lives in
[`packages/core/src/aigateway.ts`](../../packages/core/src/aigateway.ts)
(`checkAigateway`), dispatched from `checkSite` on `site.check === 'aigateway'`
([`packages/core/src/check.ts`](../../packages/core/src/check.ts)). The config
schema (`checkKindSchema`, the `aigateway` block) is in
[`packages/core/src/config.ts`](../../packages/core/src/config.ts), which also
derives the site's `url` from the gateway and model so nothing downstream has to
know this kind exists.

```
GET https://ai-gateway.vercel.sh/v1/models/{creator}/{model}/endpoints
GET https://openrouter.ai/api/v1/models/{creator}/{model}/endpoints
```
