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
  /** Text of the admin pages the EmDash plugin adds to the CMS. */
  admin: AdminDict
}

/** Strings of the EmDash admin monitor editor. */
export interface AdminDict {
  loading: string
  /** The page could not read its data (network or server failure). */
  loadFailed: string
  /** Shown instead of any configuration to a user who is not an administrator. */
  forbidden: string
  monitors: {
    title: string
    pageName: string
    heading: string
    empty: string
    add: string
    monitorN: (n: number) => string
    remove: (name: string) => string
    save: string
    saving: string
    saved: string
    /** Nothing was written because a field is invalid. */
    notSavedInvalid: string
    /** Nothing was written because someone else saved first; the newer configuration is shown. */
    notSavedStale: string
    storedUnreadable: string
    /** Button that starts replacing an unreadable stored configuration. */
    replaceStored: string
    /** Button that confirms the replacement. */
    replaceConfirm: string
    /** Button that backs out of the replacement. */
    replaceCancel: string
    /** The request failed; the edits are still in the form. */
    saveFailed: string
    /** Saved, but the check schedule could not be updated. */
    savedScheduleFailed: (error: string) => string
    /** Findings that belong to no field of the editor. */
    otherFindings: string
    warning: string
    field: {
      name: string
      slug: string
      check: string
      url: string
      method: string
      expectedStatusCodes: string
      maxResponseTime: string
      component: string
    }
    hint: {
      slug: string
      expectedStatusCodes: string
    }
    /** A slug change saves a new monitor; `old` is the slug it was loaded with. */
    slugRenamed: (old: string) => string
    duplicateSlug: (slug: string) => string
    wholeNumber: string
    wholeNumbers: string
    /** A monitor whose kind has settings this editor does not show. */
    keepsOtherSettings: string
    /** The "Test this monitor" action at the foot of a monitor. */
    test: {
      action: string
      running: string
      /** Labels of the figures in a result. */
      status: string
      responseTime: string
      responseCode: string
      /** Response code shown when the request never completed. */
      noResponse: string
      error: string
      /** The test request itself failed (network or server). */
      failed: string
      /** Status of a check whose response body exceeds the host limit; it says nothing about the target. */
      unsupported: string
    }
  }
  secrets: {
    heading: string
    intro: string
    set: string
    notSet: string
    manage: string
    slackWebhookUrl: string
    webhookUrls: string
    webhookSecret: string
    sentryToken: string
  }
  /** The status overview page and the dashboard widget. */
  overview: {
    title: string
    /** No monitor is configured, so there is nothing to list. */
    empty: string
    /** Heading of the findings that reject the stored configuration. */
    configIssues: string
    /** Label of the 90-day uptime figure. */
    uptime: string
    /** Link from the overview to the monitor editor. */
    manage: string
    /** Link from the widget to the overview page. */
    view: string
  }
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
  admin: {
    loading: 'Loading…',
    loadFailed: 'Could not load the configuration. Reload the page to try again.',
    forbidden: 'Only administrators can edit monitors.',
    monitors: {
      title: 'Monitors',
      pageName: 'Status page name',
      heading: 'Monitors',
      empty: 'No monitors yet. Add one to start checking.',
      add: 'Add monitor',
      monitorN: n => `Monitor ${n}`,
      remove: name => `Remove ${name}`,
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved.',
      notSavedInvalid: 'Not saved. Fix the marked fields and save again.',
      notSavedStale: 'Not saved. Someone else changed the configuration first, so your edit was discarded. The newer configuration is shown.',
      storedUnreadable: 'Saving is disabled. The stored configuration could not be loaded into this editor, and saving would replace it with an empty one. To start over, replace the stored configuration; nothing is changed until you save.',
      replaceStored: 'Replace the stored configuration',
      replaceConfirm: 'Replace it',
      replaceCancel: 'Cancel',
      saveFailed: 'Could not save. Your edits are still here; try again.',
      savedScheduleFailed: error => `Saved, but the check schedule could not be updated: ${error}. Save again to retry.`,
      otherFindings: 'Other findings',
      warning: 'Warning',
      field: {
        name: 'Name',
        slug: 'Slug',
        check: 'Check type',
        url: 'URL',
        method: 'HTTP method',
        expectedStatusCodes: 'Expected status codes',
        maxResponseTime: 'Slow after (ms)',
        component: 'Component',
      },
      hint: {
        slug: 'Lowercase letters, digits and hyphens. Leave empty to derive it from the name.',
        expectedStatusCodes: 'Whole numbers separated by commas, for example 200, 204.',
      },
      slugRenamed: old => `Saving stores this as a new monitor. The history of "${old}" stays under the old slug.`,
      duplicateSlug: slug => `Another monitor already uses the slug "${slug}".`,
      wholeNumber: 'Enter a whole number.',
      wholeNumbers: 'Enter whole numbers separated by commas.',
      keepsOtherSettings: 'Settings this editor does not show are kept as they are.',
      test: {
        action: 'Test this monitor',
        running: 'Testing…',
        status: 'Status',
        responseTime: 'Response time',
        responseCode: 'Response code',
        noResponse: 'none',
        error: 'Error',
        failed: 'Could not run the test. Try again.',
        unsupported: 'Unsupported (response body above the host limit)',
      },
    },
    secrets: {
      heading: 'Secrets',
      intro: 'Secret values are write-only and never shown here.',
      set: 'set',
      notSet: 'not set',
      manage: 'Manage in the plugin settings',
      slackWebhookUrl: 'Slack webhook URL',
      webhookUrls: 'Webhook URLs',
      webhookSecret: 'Webhook secret',
      sentryToken: 'Sentry token',
    },
    overview: {
      title: 'Status overview',
      empty: 'No monitors are configured yet. Add one to start checking.',
      configIssues: 'The stored configuration is rejected',
      uptime: 'Uptime (90 days)',
      manage: 'Edit monitors',
      view: 'View the status overview',
    },
  },
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
  admin: {
    loading: '加载中…',
    loadFailed: '无法加载配置。请刷新页面重试。',
    forbidden: '只有管理员可以编辑监控项。',
    monitors: {
      title: '监控项',
      pageName: '状态页名称',
      heading: '监控项',
      empty: '还没有监控项。添加一个即可开始检查。',
      add: '添加监控项',
      monitorN: n => `监控项 ${n}`,
      remove: name => `删除 ${name}`,
      save: '保存',
      saving: '正在保存…',
      saved: '已保存。',
      notSavedInvalid: '未保存。请修正标记的字段后重新保存。',
      notSavedStale: '未保存。其他人已先修改了配置，因此您的修改已被丢弃。下方显示的是较新的配置。',
      storedUnreadable: '已禁用保存。存储的配置无法载入此编辑器，保存会用空配置覆盖它。如需重新开始，请替换已存储的配置；在您保存之前不会有任何更改。',
      replaceStored: '替换已存储的配置',
      replaceConfirm: '确认替换',
      replaceCancel: '取消',
      saveFailed: '无法保存。您的修改仍保留在此，请重试。',
      savedScheduleFailed: error => `已保存，但无法更新检查计划：${error}。请再次保存以重试。`,
      otherFindings: '其他问题',
      warning: '警告',
      field: {
        name: '名称',
        slug: '标识 (slug)',
        check: '检查类型',
        url: 'URL',
        method: 'HTTP 方法',
        expectedStatusCodes: '期望的状态码',
        maxResponseTime: '超过此时间视为变慢 (ms)',
        component: '组件',
      },
      hint: {
        slug: '小写字母、数字和连字符。留空则根据名称生成。',
        expectedStatusCodes: '用逗号分隔的整数，例如 200, 204。',
      },
      slugRenamed: old => `保存后会作为新的监控项存储。“${old}”的历史记录仍保留在旧标识下。`,
      duplicateSlug: slug => `另一个监控项已使用标识“${slug}”。`,
      wholeNumber: '请输入整数。',
      wholeNumbers: '请输入以逗号分隔的整数。',
      keepsOtherSettings: '此编辑器未显示的设置将保持不变。',
      test: {
        action: '测试此监控',
        running: '正在测试…',
        status: '状态',
        responseTime: '响应时间',
        responseCode: '响应代码',
        noResponse: '无',
        error: '错误',
        failed: '无法运行测试，请重试。',
        unsupported: '不支持（响应正文超出主机限制）',
      },
    },
    secrets: {
      heading: '密钥',
      intro: '密钥值只能写入，不会在此显示。',
      set: '已设置',
      notSet: '未设置',
      manage: '在插件设置中管理',
      slackWebhookUrl: 'Slack Webhook URL',
      webhookUrls: 'Webhook URL 列表',
      webhookSecret: 'Webhook 密钥',
      sentryToken: 'Sentry 令牌',
    },
    overview: {
      title: '状态总览',
      empty: '尚未配置监控项。添加一个即可开始检查。',
      configIssues: '已存储的配置被拒绝',
      uptime: '可用率（90 天）',
      manage: '编辑监控项',
      view: '查看状态总览',
    },
  },
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
  admin: {
    loading: '読み込み中…',
    loadFailed: '設定を読み込めませんでした。ページを再読み込みしてください。',
    forbidden: 'モニターを編集できるのは管理者のみです。',
    monitors: {
      title: 'モニター',
      pageName: 'ステータスページ名',
      heading: 'モニター',
      empty: 'モニターがまだありません。追加するとチェックが始まります。',
      add: 'モニターを追加',
      monitorN: n => `モニター ${n}`,
      remove: name => `${name} を削除`,
      save: '保存',
      saving: '保存中…',
      saved: '保存しました。',
      notSavedInvalid: '保存されていません。マークされた項目を修正して、もう一度保存してください。',
      notSavedStale: '保存されていません。先に他のユーザーが設定を変更したため、あなたの編集は破棄されました。新しい設定を表示しています。',
      storedUnreadable: '保存は無効です。保存済みの設定をこのエディターに読み込めず、保存すると空の設定で上書きされます。やり直す場合は保存済みの設定を置き換えてください。保存するまで何も変更されません。',
      replaceStored: '保存済みの設定を置き換える',
      replaceConfirm: '置き換える',
      replaceCancel: 'キャンセル',
      saveFailed: '保存できませんでした。編集内容はそのまま残っています。もう一度お試しください。',
      savedScheduleFailed: error => `保存しましたが、チェックのスケジュールを更新できませんでした: ${error}。もう一度保存して再試行してください。`,
      otherFindings: 'その他の指摘',
      warning: '警告',
      field: {
        name: '名前',
        slug: 'スラッグ',
        check: 'チェックの種類',
        url: 'URL',
        method: 'HTTP メソッド',
        expectedStatusCodes: '期待するステータスコード',
        maxResponseTime: '遅延とみなす時間 (ms)',
        component: 'コンポーネント',
      },
      hint: {
        slug: '小文字の英字、数字、ハイフン。空欄の場合は名前から生成されます。',
        expectedStatusCodes: 'カンマ区切りの整数 (例: 200, 204)。',
      },
      slugRenamed: old => `保存すると新しいモニターとして保存されます。「${old}」の履歴は古いスラッグのまま残ります。`,
      duplicateSlug: slug => `スラッグ「${slug}」は別のモニターですでに使われています。`,
      wholeNumber: '整数を入力してください。',
      wholeNumbers: 'カンマ区切りの整数を入力してください。',
      keepsOtherSettings: 'このエディターに表示されない設定はそのまま保持されます。',
      test: {
        action: 'このモニターをテスト',
        running: 'テスト中…',
        status: 'ステータス',
        responseTime: '応答時間',
        responseCode: '応答コード',
        noResponse: 'なし',
        error: 'エラー',
        failed: 'テストを実行できませんでした。もう一度お試しください。',
        unsupported: '非対応（レスポンス本文がホストの上限を超えています）',
      },
    },
    secrets: {
      heading: 'シークレット',
      intro: 'シークレットの値は書き込み専用で、ここには表示されません。',
      set: '設定済み',
      notSet: '未設定',
      manage: 'プラグイン設定で管理',
      slackWebhookUrl: 'Slack Webhook URL',
      webhookUrls: 'Webhook URL 一覧',
      webhookSecret: 'Webhook シークレット',
      sentryToken: 'Sentry トークン',
    },
    overview: {
      title: 'ステータス概要',
      empty: 'モニターがまだ設定されていません。追加すると確認を開始します。',
      configIssues: '保存されている設定が拒否されました',
      uptime: '稼働率（90日）',
      manage: 'モニターを編集',
      view: 'ステータス概要を表示',
    },
  },
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
  admin: {
    loading: '불러오는 중…',
    loadFailed: '설정을 불러오지 못했습니다. 페이지를 새로 고쳐 다시 시도하세요.',
    forbidden: '모니터는 관리자만 편집할 수 있습니다.',
    monitors: {
      title: '모니터',
      pageName: '상태 페이지 이름',
      heading: '모니터',
      empty: '아직 모니터가 없습니다. 추가하면 점검이 시작됩니다.',
      add: '모니터 추가',
      monitorN: n => `모니터 ${n}`,
      remove: name => `${name} 삭제`,
      save: '저장',
      saving: '저장하는 중…',
      saved: '저장했습니다.',
      notSavedInvalid: '저장하지 않았습니다. 표시된 필드를 고친 뒤 다시 저장하세요.',
      notSavedStale: '저장하지 않았습니다. 다른 사람이 먼저 설정을 바꿨으므로 내 수정은 버려졌습니다. 더 새로운 설정을 보여 줍니다.',
      storedUnreadable: '저장할 수 없습니다. 저장된 설정을 이 편집기로 불러오지 못했으며, 저장하면 빈 설정으로 덮어쓰게 됩니다. 처음부터 다시 시작하려면 저장된 설정을 교체하세요. 저장하기 전에는 아무것도 바뀌지 않습니다.',
      replaceStored: '저장된 설정 교체',
      replaceConfirm: '교체',
      replaceCancel: '취소',
      saveFailed: '저장하지 못했습니다. 수정 내용은 그대로 남아 있으니 다시 시도하세요.',
      savedScheduleFailed: error => `저장했지만 점검 일정을 갱신하지 못했습니다: ${error}. 다시 저장해 재시도하세요.`,
      otherFindings: '기타 항목',
      warning: '경고',
      field: {
        name: '이름',
        slug: '슬러그',
        check: '점검 유형',
        url: 'URL',
        method: 'HTTP 메서드',
        expectedStatusCodes: '기대하는 상태 코드',
        maxResponseTime: '느린 것으로 보는 시간 (ms)',
        component: '구성 요소',
      },
      hint: {
        slug: '소문자, 숫자, 하이픈만 쓸 수 있습니다. 비워 두면 이름에서 만듭니다.',
        expectedStatusCodes: '쉼표로 구분한 정수입니다. 예: 200, 204.',
      },
      slugRenamed: old => `저장하면 새 모니터로 저장됩니다. "${old}"의 기록은 이전 슬러그에 그대로 남습니다.`,
      duplicateSlug: slug => `다른 모니터가 이미 슬러그 "${slug}"을(를) 사용합니다.`,
      wholeNumber: '정수를 입력하세요.',
      wholeNumbers: '쉼표로 구분한 정수를 입력하세요.',
      keepsOtherSettings: '이 편집기에 표시되지 않는 설정은 그대로 유지됩니다.',
      test: {
        action: '이 모니터 테스트',
        running: '테스트 중…',
        status: '상태',
        responseTime: '응답 시간',
        responseCode: '응답 코드',
        noResponse: '없음',
        error: '오류',
        failed: '테스트를 실행할 수 없습니다. 다시 시도하세요.',
        unsupported: '지원 안 함 (응답 본문이 호스트 한도를 초과함)',
      },
    },
    secrets: {
      heading: '시크릿',
      intro: '시크릿 값은 쓰기 전용이며 여기에 표시되지 않습니다.',
      set: '설정됨',
      notSet: '설정 안 됨',
      manage: '플러그인 설정에서 관리',
      slackWebhookUrl: 'Slack 웹훅 URL',
      webhookUrls: '웹훅 URL 목록',
      webhookSecret: '웹훅 시크릿',
      sentryToken: 'Sentry 토큰',
    },
    overview: {
      title: '상태 개요',
      empty: '설정된 모니터가 없습니다. 모니터를 추가하면 확인이 시작됩니다.',
      configIssues: '저장된 설정이 거부되었습니다',
      uptime: '가동률(90일)',
      manage: '모니터 편집',
      view: '상태 개요 보기',
    },
  },
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
