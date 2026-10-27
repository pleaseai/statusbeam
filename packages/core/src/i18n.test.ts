import { describe, expect, it } from 'bun:test'
import { DEFAULT_LOCALE, formatDay, getDict, isLocale, LOCALES, matchLocale, negotiateLocale, resolveLocale } from './i18n'

/** Recursively assert every string leaf of a Dict subtree is non-empty. */
function expectNonEmptyStrings(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new Error(`empty translation string at ${path}`)
    }
    return
  }
  // Function-valued entries (windowStart/ariaUptime/breakdown) are exercised
  // separately with sample arguments below.
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      expectNonEmptyStrings(child, `${path}.${key}`)
    }
  }
}

describe('resolveLocale', () => {
  it('collapses regional variants to the base language', () => {
    expect(resolveLocale('zh-CN')).toBe('zh')
    expect(resolveLocale('ja_JP')).toBe('ja')
    expect(resolveLocale('ko-KR')).toBe('ko')
    expect(resolveLocale('en-US')).toBe('en')
  })

  it('falls back to the default for unknown or empty input', () => {
    expect(resolveLocale('fr')).toBe(DEFAULT_LOCALE)
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE)
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE)
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE)
  })
})

describe('matchLocale', () => {
  it('returns the supported locale for a matching tag, else null', () => {
    expect(matchLocale('ja')).toBe('ja')
    expect(matchLocale('zh-CN')).toBe('zh')
    expect(matchLocale('fr')).toBeNull()
    expect(matchLocale('')).toBeNull()
    expect(matchLocale(null)).toBeNull()
    expect(matchLocale(undefined)).toBeNull()
  })
})

describe('isLocale', () => {
  it('accepts supported locales and rejects everything else', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('ko')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(42)).toBe(false)
  })
})

describe('getDict', () => {
  it('provides a complete dictionary for every supported locale', () => {
    for (const locale of LOCALES) {
      const dict = getDict(locale)
      // Every string leaf (page.title, chart.*, unit.ms, etc.) must be non-empty
      // — a translator shipping "" for any key is caught, not just spot-checks.
      expectNonEmptyStrings(dict, locale)
      // Function-valued entries must produce non-empty output.
      expect(dict.timeline.windowStart(90)).toContain('90')
      expect(dict.timeline.ariaUptime('99%').length).toBeGreaterThan(0)
      expect(dict.breakdown({ day: '100%', week: '99%', month: '98%', quarter: '97%' })).toContain('100%')
      expect(dict.admin.monitors.monitorN(2)).toContain('2')
      expect(dict.admin.monitors.remove('API')).toContain('API')
      expect(dict.admin.monitors.slugRenamed('old-slug')).toContain('old-slug')
      expect(dict.admin.monitors.duplicateSlug('dup-slug')).toContain('dup-slug')
      expect(Object.keys(dict.admin.monitors.test)).toHaveLength(8)
    }
  })

  it('labels a site not checked yet in every locale, apart from every severity label', () => {
    for (const locale of LOCALES) {
      const dict = getDict(locale)
      expect(Object.values(dict.severity)).not.toContain(dict.status.notChecked)
    }
    expect(getDict('en').status.notChecked).toBe('Not checked yet')
  })

  it('translates the banner headline per locale', () => {
    expect(getDict('en').banner.operational).toBe('All Systems Operational')
    expect(getDict('ko').banner.operational).toBe('모든 시스템 정상')
    expect(getDict('ja').banner.operational).toBe('すべてのシステムが正常')
    expect(getDict('zh').banner.operational).toBe('所有系统正常')
  })
})

describe('formatDay', () => {
  it('formats a UTC ISO date per locale', () => {
    expect(formatDay('2026-07-05', 'en')).toBe('Jul 5, 2026')
    expect(formatDay('2026-07-05', 'ko')).toContain('2026')
    expect(formatDay('2026-07-05', 'ja')).toContain('年')
  })

  it('returns the raw input for a malformed date', () => {
    expect(formatDay('nope', 'en')).toBe('nope')
  })

  it('does not throw on 3-segment non-numeric dates (regression guard)', () => {
    // All three segments are present but NaN — a naive guard let these through
    // and Intl.DateTimeFormat.format() threw, crashing the SSR render. Must
    // degrade to the raw string instead.
    expect(() => formatDay('20xx-07-05', 'en')).not.toThrow()
    expect(formatDay('20xx-07-05', 'en')).toBe('20xx-07-05')
    expect(formatDay('2026-ab-05', 'ja')).toBe('2026-ab-05')
  })

  it('rejects out-of-range parts instead of rendering a normalized date', () => {
    // Date.UTC normalizes overflow: month 13 → next January, day 31 in Feb →
    // early March. The round-trip guard must reject these rather than show a
    // plausible-but-wrong date.
    expect(formatDay('2026-13-05', 'en')).toBe('2026-13-05')
    expect(formatDay('2026-02-31', 'en')).toBe('2026-02-31')
    expect(formatDay('2026-00-10', 'en')).toBe('2026-00-10')
  })

  it('renders the same calendar day regardless of the host timezone (UTC)', () => {
    // Midnight UTC on Jul 5 is still Jul 4 in Los Angeles; the explicit
    // timeZone: 'UTC' must keep the output stable across host timezones.
    const original = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      expect(formatDay('2026-07-05', 'en')).toBe('Jul 5, 2026')
    }
    finally {
      process.env.TZ = original
    }
  })
})

describe('negotiateLocale', () => {
  it('prefers a valid remembered cookie over the preferred locale', () => {
    expect(negotiateLocale('ko', 'ja')).toBe('ko')
  })

  it('ignores an invalid cookie and uses the preferred locale', () => {
    expect(negotiateLocale('xx', 'ja')).toBe('ja')
    expect(negotiateLocale(undefined, 'zh-CN')).toBe('zh')
  })

  it('returns null when neither signal names a supported locale', () => {
    // The caller supplies the deployment fallback via `?? fallback`, keeping an
    // async/KV fallback lazy — so an unmatched request yields null here.
    expect(negotiateLocale(null, 'fr')).toBeNull()
    expect(negotiateLocale(null, null)).toBeNull()
    expect(negotiateLocale(undefined, undefined)).toBeNull()
  })
})
