import type { AdminDict, Locale } from '@statusbeam/core'
import { getDict, matchLocale } from '@statusbeam/core'
import { useSyncExternalStore } from 'react'

/** The locale of the admin, as the admin itself publishes it on `<html lang>`. */
function documentLocale(): string | null {
  return typeof document === 'undefined' ? null : document.documentElement.getAttribute('lang')
}

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

/** One observer of `<html lang>` for every subscriber (a bar chart mounts a hook per day), created with the first and disconnected with the last. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (observer === null) {
    observer = new MutationObserver(() => listeners.forEach(notify => notify()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

/**
 * StatusBeam's strings for the admin locale (NFR-1). The text comes from core's
 * dictionary, which covers `en`, `zh`, `ja` and `ko`; any other admin locale
 * (Arabic, say) reads English. The admin's `LocaleDirectionProvider` keeps
 * `<html lang>` in step with the active locale, so the hook follows a switch.
 */
export function useAdminLocale(): Locale {
  const tag = useSyncExternalStore(subscribe, documentLocale, () => null)
  return matchLocale(tag) ?? 'en'
}

export function useAdminDict(): AdminDict {
  return getDict(useAdminLocale()).admin
}
