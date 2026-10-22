import type { Locale } from '@statusbeam/core/contract'

/**
 * Strings only the render library needs. Everything else (severity labels,
 * banner headlines, timeline copy) comes from core's `getDict`, the same
 * dictionary `apps/web` renders, so labels match the standalone page.
 */
export interface UiMessages {
  /** Shown in place of a component when its source fails or breaks the contract. */
  unavailable: string
}

const MESSAGES: Record<Locale, UiMessages> = {
  en: { unavailable: 'Status unavailable' },
  zh: { unavailable: '状态不可用' },
  ja: { unavailable: 'ステータスを取得できません' },
  ko: { unavailable: '상태를 확인할 수 없음' },
}

export function getMessages(locale: Locale): UiMessages {
  return MESSAGES[locale]
}
