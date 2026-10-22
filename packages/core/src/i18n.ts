import type { IncidentState } from './incidents'
import type { Severity } from './types'

/**
 * Supported UI locales. English is the source language; `zh`/`ja`/`ko` are the
 * CJK translations. Regional variants (e.g. `zh-CN`, `en-US`) collapse to their
 * base language via {@link resolveLocale}.
 */
export const LOCALES = ['en', 'zh', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]

/** Fallback locale when none is configured or a value can't be resolved. */
export const DEFAULT_LOCALE: Locale = 'en'

/** Narrow an arbitrary value to a supported {@link Locale}. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * The supported {@link Locale} a locale-ish string maps to, collapsing regional
 * variants (`zh-CN`, `ja_JP`) to their base language — or `null` when it names
 * no supported locale. Use this when "unsupported" must be handled distinctly
 * from "defaulted"; use {@link resolveLocale} when a default is always wanted.
 */
export function matchLocale(input: string | null | undefined): Locale | null {
  if (!input) {
    return null
  }
  const base = input.toLowerCase().split(/[-_]/)[0] ?? ''
  return isLocale(base) ? base : null
}

/**
 * Normalize a locale-ish string (config value, `Accept-Language`, `?lang`) to a
 * supported {@link Locale}, collapsing regional variants (`zh-CN`, `ja_JP`) to
 * their base language and falling back to {@link DEFAULT_LOCALE}.
 */
export function resolveLocale(input: string | null | undefined): Locale {
  return matchLocale(input) ?? DEFAULT_LOCALE
}

/** The `day` bucket keys used by the 90-day uptime timeline. */
export type DayKey = 'up' | 'degraded' | 'down' | 'nodata'

/** The full set of translatable UI strings for one locale. */
export interface Dict {
  page: { title: string }
  /** Accessible names for UI chrome (not visible copy), e.g. the switcher nav. */
  a11y: { languageNav: string, themeToggle: string }
  /** Theme-toggle mode labels (system-following, forced light, forced dark). */
  theme: { light: string, dark: string, system: string }
  /** Roll-up banner headline, keyed by overall severity. */
  banner: Record<Severity, string>
  /** Short badge label, keyed by severity. */
  severity: Record<Severity, string>
  /** Incident lifecycle-state badge label. */
  state: Record<IncidentState, string>
  /** Per-day timeline bucket label. */
  day: Record<DayKey, string>
  incidents: { heading: string, recentlyResolved: string, none: string }
  /** `notChecked` labels a site with no real result yet (`pending` in the contract). */
  status: { responseTime: string, notChecked: string }
  chart: { avg: string, p95: string, responseTime: string, noData: string }
  /** Unit suffix for response-time figures (kept as the symbol across locales). */
  unit: { ms: string }
  timeline: {
    today: string
    windowStart: (days: number) => string
    ariaUptime: (uptime: string) => string
    /** Accessible name of a timeline with no checked day, which has no uptime figure. */
    ariaNoData: string
  }
  /** Uptime tooltip breakdown, e.g. "Today 100% · 7d 99.9% · …". */
  breakdown: (parts: { day: string, week: string, month: string, quarter: string }) => string
}

const en: Dict = {
  page: { title: 'Status' },
  a11y: { languageNav: 'Language', themeToggle: 'Theme' },
  theme: { light: 'Light', dark: 'Dark', system: 'System' },
  banner: {
    operational: 'All Systems Operational',
    degraded: 'Degraded Performance',
    partial_outage: 'Partial System Outage',
    major_outage: 'Major System Outage',
    maintenance: 'Under Maintenance',
  },
  severity: {
    operational: 'Operational',
    degraded: 'Degraded',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    maintenance: 'Maintenance',
  },
  state: {
    investigating: 'Investigating',
    identified: 'Identified',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
  },
  day: {
    up: 'Operational',
    degraded: 'Degraded',
    down: 'Outage',
    nodata: 'No data',
  },
  incidents: {
    heading: 'Incidents',
    recentlyResolved: 'Recently resolved',
    none: 'No incidents reported in the last 90 days.',
  },
  status: { responseTime: 'Response time', notChecked: 'Not checked yet' },
  chart: {
    avg: 'avg',
    p95: 'p95',
    responseTime: 'Response time',
    noData: 'No response-time data yet.',
  },
  unit: { ms: 'ms' },
  timeline: {
    today: 'Today',
    windowStart: days => `${days} days ago`,
    ariaUptime: uptime => `90-day uptime history — ${uptime} uptime`,
    ariaNoData: '90-day uptime history — no data yet',
  },
  breakdown: ({ day, week, month, quarter }) =>
    `Today ${day} · 7d ${week} · 30d ${month} · 90d ${quarter}`,
}

const zh: Dict = {
  page: { title: '服务状态' },
  a11y: { languageNav: '语言', themeToggle: '主题' },
  theme: { light: '浅色', dark: '深色', system: '跟随系统' },
  banner: {
    operational: '所有系统正常',
    degraded: '性能下降',
    partial_outage: '部分系统故障',
    major_outage: '重大系统故障',
    maintenance: '维护中',
  },
  severity: {
    operational: '正常',
    degraded: '性能下降',
    partial_outage: '部分故障',
    major_outage: '重大故障',
    maintenance: '维护',
  },
  state: {
    investigating: '调查中',
    identified: '已定位',
    monitoring: '监控中',
    resolved: '已解决',
  },
  day: {
    up: '正常',
    degraded: '性能下降',
    down: '故障',
    nodata: '无数据',
  },
  incidents: {
    heading: '事件',
    recentlyResolved: '最近已解决',
    none: '过去 90 天内没有报告任何事件。',
  },
  status: { responseTime: '响应时间', notChecked: '尚未检查' },
  chart: {
    avg: '平均',
    p95: 'p95',
    responseTime: '响应时间',
    noData: '暂无响应时间数据。',
  },
  unit: { ms: 'ms' },
  timeline: {
    today: '今日',
    windowStart: days => `${days} 天前`,
    ariaUptime: uptime => `90 天正常运行记录 — 正常运行率 ${uptime}`,
    ariaNoData: '90 天正常运行记录 — 暂无数据',
  },
  breakdown: ({ day, week, month, quarter }) =>
    `今日 ${day} · 7天 ${week} · 30天 ${month} · 90天 ${quarter}`,
}

const ja: Dict = {
  page: { title: 'ステータス' },
  a11y: { languageNav: '言語', themeToggle: 'テーマ' },
  theme: { light: 'ライト', dark: 'ダーク', system: 'システム' },
  banner: {
    operational: 'すべてのシステムが正常',
    degraded: 'パフォーマンス低下',
    partial_outage: '一部システム障害',
    major_outage: '重大なシステム障害',
    maintenance: 'メンテナンス中',
  },
  severity: {
    operational: '正常',
    degraded: '低下',
    partial_outage: '一部障害',
    major_outage: '重大障害',
    maintenance: 'メンテナンス',
  },
  state: {
    investigating: '調査中',
    identified: '原因特定',
    monitoring: '監視中',
    resolved: '解決済み',
  },
  day: {
    up: '正常',
    degraded: '低下',
    down: '障害',
    nodata: 'データなし',
  },
  incidents: {
    heading: 'インシデント',
    recentlyResolved: '最近解決済み',
    none: '過去90日間に報告されたインシデントはありません。',
  },
  status: { responseTime: '応答時間', notChecked: '未確認' },
  chart: {
    avg: '平均',
    p95: 'p95',
    responseTime: '応答時間',
    noData: '応答時間のデータはまだありません。',
  },
  unit: { ms: 'ms' },
  timeline: {
    today: '今日',
    windowStart: days => `${days}日前`,
    ariaUptime: uptime => `90日間の稼働率履歴 — 稼働率 ${uptime}`,
    ariaNoData: '90日間の稼働率履歴 — データなし',
  },
  breakdown: ({ day, week, month, quarter }) =>
    `今日 ${day} · 7日 ${week} · 30日 ${month} · 90日 ${quarter}`,
}

const ko: Dict = {
  page: { title: '상태' },
  a11y: { languageNav: '언어', themeToggle: '테마' },
  theme: { light: '라이트', dark: '다크', system: '시스템' },
  banner: {
    operational: '모든 시스템 정상',
    degraded: '성능 저하',
    partial_outage: '부분 장애',
    major_outage: '주요 장애',
    maintenance: '점검 중',
  },
  severity: {
    operational: '정상',
    degraded: '성능 저하',
    partial_outage: '부분 장애',
    major_outage: '주요 장애',
    maintenance: '점검',
  },
  state: {
    investigating: '조사 중',
    identified: '원인 파악',
    monitoring: '모니터링',
    resolved: '해결됨',
  },
  day: {
    up: '정상',
    degraded: '성능 저하',
    down: '장애',
    nodata: '데이터 없음',
  },
  incidents: {
    heading: '인시던트',
    recentlyResolved: '최근 해결됨',
    none: '최근 90일간 보고된 인시던트가 없습니다.',
  },
  status: { responseTime: '응답 시간', notChecked: '확인 전' },
  chart: {
    avg: '평균',
    p95: 'p95',
    responseTime: '응답 시간',
    noData: '아직 응답 시간 데이터가 없습니다.',
  },
  unit: { ms: 'ms' },
  timeline: {
    today: '오늘',
    windowStart: days => `${days}일 전`,
    ariaUptime: uptime => `90일 가동률 기록 — 가동률 ${uptime}`,
    ariaNoData: '90일 가동률 기록 — 데이터 없음',
  },
  breakdown: ({ day, week, month, quarter }) =>
    `오늘 ${day} · 7일 ${week} · 30일 ${month} · 90일 ${quarter}`,
}

const DICTS: Record<Locale, Dict> = { en, zh, ja, ko }

/** The translation dictionary for `locale`. */
export function getDict(locale: Locale): Dict {
  // `DICTS` is a fully-populated `Record<Locale, Dict>`, so the index is always
  // present — the `??` is defense-in-depth, not compiler-required.
  return DICTS[locale] ?? DICTS[DEFAULT_LOCALE]
}

/**
 * Resolve the UI locale from the signals a request carries, in precedence
 * order: the visitor's remembered choice (`cookie`), then their
 * `preferredLocale`. Returns `null` when neither names a supported locale, so
 * the caller supplies the final fallback via `?? fallback` — which lets an
 * async/expensive fallback (e.g. a KV config read) stay lazy, evaluated only
 * when neither signal decides.
 *
 * `preferredLocale` is expected to be an already-negotiated locale tag — Astro's
 * `Astro.preferredLocale`, which resolves `Accept-Language` q-values against the
 * configured locales — not a raw multi-range `Accept-Language` header. Pure so
 * it can be unit-tested independently of the Astro middleware.
 */
export function negotiateLocale(
  cookie: string | null | undefined,
  preferredLocale: string | null | undefined,
): Locale | null {
  return matchLocale(cookie) ?? matchLocale(preferredLocale)
}

/**
 * Format an ISO date (`YYYY-MM-DD`, UTC) for `locale`, e.g. "Jul 5, 2026" /
 * "2026年7月5日" / "2026년 7월 5일". Uses UTC so a day bucket reads the same
 * regardless of the viewer's timezone. Degrades to the raw input on a malformed
 * date rather than throwing (the caller renders untrusted KV-sourced dates).
 */
export function formatDay(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) {
    return iso
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  // Reject malformed dates by requiring the parsed parts to round-trip. This
  // catches both non-numeric segments ("20xx-07-05" → NaN date, which would make
  // Intl.DateTimeFormat.format() throw and crash the SSR render) and out-of-range
  // parts that Date.UTC silently normalizes ("2026-13-05" → 2027-01-05), which
  // would otherwise render a plausible but wrong date.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return iso
  }
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}
