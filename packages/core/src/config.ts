import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { aigatewayEndpointsUrl } from './aigateway'
import { DEFAULT_LOCALE, LOCALES } from './i18n'

/**
 * How a single service is checked. `incidentio` reads an incident.io status
 * page, which serves a Statuspage-compatible `summary.json`, so it shares the
 * `statuspage` code path (see check.ts). `sentry` mirrors a Sentry Uptime
 * monitor: the primary path is an inbound issue webhook (`POST /webhooks/sentry/:slug`),
 * with an optional poll backstop that reads Sentry's Issues API (see sentry.ts).
 * `aigateway` reads a model's published endpoint health from the Vercel AI
 * Gateway or OpenRouter (see aigateway.ts).
 */
export const checkKindSchema = z.enum(['http', 'tcp', 'ssl', 'statuspage', 'incidentio', 'sentry', 'aigateway'])
export type CheckKind = z.infer<typeof checkKindSchema>

/**
 * Poll-backstop settings for a `check: sentry` site. Optional: when omitted the
 * site is **webhook-only** (the cron loop skips it and status comes purely from
 * `POST /webhooks/sentry/:slug`). When present it enables the poll backstop,
 * which reads Sentry's Issues API — a `SENTRY_AUTH_TOKEN` must also be set on the
 * Worker (the token is a secret and never lives in this config). Sentry exposes
 * no dedicated "current uptime status" endpoint, so the backstop reads whether an
 * unresolved outage issue exists for the monitor.
 */
export const sentryConfigSchema = z.object({
  /** Sentry organization slug (the `…/organizations/<org>/…` path segment). */
  org: z.string().min(1),
  /** Optional project id or slug to scope the issue query to one project. */
  project: z.string().min(1).optional(),
  /**
   * Optional override for the issue search query used to decide up/down. Defaults
   * to `is:unresolved issue.category:outage`. Narrow it (e.g. add the monitored
   * host) when a project has more than one uptime monitor, so the backstop grades
   * the right one. The webhook path is precise; the poll query is best-effort.
   */
  query: z.string().min(1).optional(),
  /**
   * Optional API host override for a Sentry region or self-hosted install
   * (e.g. `https://us.sentry.io`, `https://de.sentry.io`, or your own domain).
   * Defaults to `https://sentry.io`.
   */
  host: z.string().url().optional(),
})
export type SentryConfig = z.infer<typeof sentryConfigSchema>

/** Which model-routing gateway publishes the endpoint health we read. */
export const aigatewayProviderSchema = z.enum(['vercel', 'openrouter'])
export type AigatewayProvider = z.infer<typeof aigatewayProviderSchema>

/**
 * Settings for a `check: aigateway` site: which model, on which gateway, and the
 * uptime thresholds that turn the gateway's published telemetry into a verdict.
 * Both gateways expose this data unauthenticated, so no token is involved — and
 * no probe traffic is sent to the model (see aigateway.ts).
 */
export const aigatewayConfigSchema = z
  .object({
    /** The gateway that publishes the telemetry. */
    provider: aigatewayProviderSchema,
    /** Model id in `creator/model` form, e.g. `anthropic/claude-opus-4.5`. */
    model: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'model must be in creator/model form, e.g. anthropic/claude-opus-4.5'),
    /**
     * Optional single endpoint (one provider serving the model) to track,
     * matched case-insensitively against `tag`, then `provider_name`, then the
     * full `name`. When omitted the model is graded across all its endpoints and
     * the best one wins — the gateway routes around a failing provider.
     */
    endpoint: z.string().min(1).optional(),
    /** Published uptime percentage below this marks the endpoint `degraded`. */
    degradedUptime: z.number().min(0).max(100).default(99),
    /** Published uptime percentage below this marks the endpoint `down`. */
    downUptime: z.number().min(0).max(100).default(50),
  })
  .superRefine((cfg, ctx) => {
    // An inverted pair would make `down` unreachable (or swallow `degraded`
    // entirely); catch it at parse time rather than grading with it.
    if (cfg.downUptime > cfg.degradedUptime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['downUptime'],
        message: `downUptime must be at or below degradedUptime (got ${cfg.downUptime} > ${cfg.degradedUptime})`,
      })
    }
  })
export type AigatewayConfig = z.infer<typeof aigatewayConfigSchema>

/** Turn a human name into a stable, URL-safe slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const siteSchema = z
  .object({
    name: z.string().min(1),
    /**
     * The endpoint to check, or the status-page base URL for the mirroring
     * adapters. Optional only for `check: aigateway`, whose URL is derived from
     * the `aigateway` block; required for every other kind (see superRefine).
     */
    url: z.string().url().optional(),
    check: checkKindSchema.default('http'),
    method: z.string().default('GET'),
    expectedStatusCodes: z.array(z.number().int()).default([200]),
    /** Response time above this (ms) marks the site `degraded` rather than `up`. */
    maxResponseTime: z.number().int().positive().default(5000),
    /**
     * For `check: statuspage` / `incidentio` only (both read the same
     * Statuspage-format payload). Reads one component by name (case-insensitive)
     * or id; when omitted, the page's overall indicator is used. Rejected at
     * parse time for other check kinds (see superRefine below) so a mistyped
     * `check` doesn't silently ignore the field.
     */
    component: z.string().min(1).optional(),
    /**
     * For `check: sentry` only — enables the poll backstop (see
     * {@link sentryConfigSchema}). Omit for a webhook-only Sentry site. Rejected
     * at parse time for other check kinds (see superRefine below).
     */
    sentry: sentryConfigSchema.optional(),
    /**
     * For `check: aigateway` only — which model on which gateway to read (see
     * {@link aigatewayConfigSchema}). Required for that kind and rejected at
     * parse time for every other one (see superRefine below).
     */
    aigateway: aigatewayConfigSchema.optional(),
    /**
     * Optional explicit slug; defaults to slugify(name). Constrained to the
     * same charset slugify emits so it's safe to embed in a `Cache-Tag` (no
     * commas/whitespace, which would corrupt the header — see cache.ts).
     */
    slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and hyphens').optional(),
  })
  .superRefine((site, ctx) => {
    // `component` only means something for statuspage/incidentio checks; surface
    // a mistyped `check` (or a stray `component:` line) as a parse error instead
    // of quietly ignoring it at runtime.
    if (site.component !== undefined && site.check !== 'statuspage' && site.check !== 'incidentio') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['component'],
        message: `component is only valid with check: statuspage or incidentio (got check: ${site.check})`,
      })
    }
    // `sentry` config only means something for a `check: sentry` site; surface a
    // mistyped `check` (or a stray `sentry:` block) as a parse error rather than
    // quietly ignoring the poll-backstop settings at runtime.
    if (site.sentry !== undefined && site.check !== 'sentry') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sentry'],
        message: `sentry config is only valid with check: sentry (got check: ${site.check})`,
      })
    }
    // Same for the `aigateway` block — and unlike `sentry` it is *required* for
    // its kind: there is no webhook path, so without it the check has no model
    // to read and no URL to derive.
    if (site.aigateway !== undefined && site.check !== 'aigateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aigateway'],
        message: `aigateway config is only valid with check: aigateway (got check: ${site.check})`,
      })
    }
    if (site.aigateway === undefined && site.check === 'aigateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aigateway'],
        message: 'aigateway config is required for check: aigateway',
      })
    }
    // Every other kind fetches (or displays) a URL the user supplies. `url` is
    // optional in the object schema only so an `aigateway` site can omit it.
    if (site.url === undefined && site.check !== 'aigateway') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `url is required for check: ${site.check}`,
      })
    }
  })
  .transform(site => ({
    ...site,
    slug: site.slug ?? slugify(site.name),
    // An `aigateway` site needs no user-supplied URL — the gateway's endpoints
    // URL *is* the thing being read — so derive it and keep `Site['url']` a
    // plain string for everything downstream. The refinement above guarantees
    // the block is present for that kind, so the `''` fallback is unreachable.
    url: site.url ?? (site.aigateway ? aigatewayEndpointsUrl(site.aigateway) : ''),
  }))

export type Site = z.infer<typeof siteSchema>

/**
 * How status-change notifications reach their targets.
 *
 * - `inline` (default): POST each target directly from the run via `fetch`.
 *   Best-effort — a failed POST is logged, never retried. Works on the free
 *   Workers plan; adequate for the low volume of status-change alerts.
 * - `queue`: enqueue each target onto a Cloudflare Queue whose consumer does
 *   the POST, gaining automatic retries + backoff and dead-lettering. Needs the
 *   `queues` bindings in wrangler.jsonc. Cloudflare Queues is available on the
 *   Workers Free plan (10k ops/day, 24h dead-letter retention); the Paid plan
 *   raises those limits and extends retention to 14 days.
 */
export const notificationDeliverySchema = z.enum(['inline', 'queue'])
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>

/**
 * Optional outbound notification targets. Every field is optional so existing
 * configs without a `notifications` block keep parsing unchanged; `delivery`
 * defaults to `inline` so adding it never changes existing behavior.
 */
export const notificationsSchema = z.object({
  delivery: notificationDeliverySchema.default('inline'),
  slack: z.object({ webhookUrl: z.string().url() }).optional(),
  webhooks: z.array(z.object({ url: z.string().url() })).optional(),
})
export type Notifications = z.infer<typeof notificationsSchema>

export const themeSchema = z
  .object({
    logoUrl: z.string().optional(),
    darkMode: z.boolean().default(true),
    /** UI language for the status page. Defaults to English. */
    locale: z.enum(LOCALES).default(DEFAULT_LOCALE),
  })
  .default({ darkMode: true, locale: DEFAULT_LOCALE })

export const configSchema = z.object({
  name: z.string().min(1),
  sites: z.array(siteSchema).min(1),
  notifications: notificationsSchema.optional(),
  theme: themeSchema,
})

export type StatusConfig = z.infer<typeof configSchema>

/** Parse and validate a `status.config.yml` document. Throws on invalid input. */
export function parseConfig(yaml: string): StatusConfig {
  return configSchema.parse(parseYaml(yaml))
}
