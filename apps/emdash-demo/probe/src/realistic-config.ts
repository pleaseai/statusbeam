/**
 * A realistic `status.config.yml` for the FR-20 re-validation cost measurement:
 * 25 monitors that mix the http, statuspage, incidentio, sentry and aigateway
 * check kinds (no tcp or ssl), plus a notifications block and a theme. `parseConfig` runs YAML parsing and the full
 * zod schema (including the per-site superRefine and slug transform) over it.
 */
const kinds = [
  (i: number) => `  - name: API ${i}
    url: https://api-${i}.example.com/health
    check: http
    method: GET
    expectedStatusCodes: [200, 204]
    maxResponseTime: 2000`,
  (i: number) => `  - name: Vendor ${i}
    url: https://status.vendor-${i}.example.com
    check: statuspage
    component: API`,
  (i: number) => `  - name: Incident ${i}
    url: https://status.incident-${i}.example.com
    check: incidentio`,
  (i: number) => `  - name: Sentry ${i}
    url: https://app-${i}.example.com
    check: sentry
    sentry:
      org: example
      project: app-${i}`,
  (i: number) => `  - name: Model ${i}
    check: aigateway
    aigateway:
      provider: openrouter
      model: openai/gpt-4o-mini`,
]

const sites = Array.from({ length: 25 }, (_, i) => kinds[i % kinds.length]!(i)).join('\n')

export const REALISTIC_CONFIG = `name: Spike Status
sites:
${sites}
notifications:
  delivery: inline
theme:
  darkMode: true
  locale: en
`

export const REALISTIC_MONITORS = 25
