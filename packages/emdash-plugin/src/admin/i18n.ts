import type { AdminDict, Locale } from '@statusbeam/core'
import { getDict, matchLocale } from '@statusbeam/core'
import { useEffect, useState } from 'react'

/** The locale of the admin, as the admin itself publishes it on `<html lang>`. */
function documentLocale(): string | null {
  return typeof document === 'undefined' ? null : document.documentElement.getAttribute('lang')
}

/**
 * StatusBeam's strings for the admin locale (NFR-1). The text comes from core's
 * dictionary, which covers `en`, `zh`, `ja` and `ko`; any other admin locale
 * (Arabic, say) reads English. The admin's `LocaleDirectionProvider` keeps
 * `<html lang>` in step with the active locale, so the hook follows a switch.
 */
export function useAdminLocale(): Locale {
  const [tag, setTag] = useState(documentLocale)
  useEffect(() => {
    setTag(documentLocale())
    const observer = new MutationObserver(() => setTag(documentLocale()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => observer.disconnect()
  }, [])
  return matchLocale(tag) ?? 'en'
}

export function useAdminDict(): AdminDict {
  return getDict(useAdminLocale()).admin
}
