import type { StatusConfig } from './config'
import { parse as parseYaml } from 'yaml'
import { configSchema } from './config'

/** One problem found in a configuration document. */
export interface ConfigIssue {
  /** `syntax` for malformed YAML, `schema` for a document that parses but is invalid. */
  kind: 'syntax' | 'schema'
  /** Path of the offending field, e.g. `sites[0].url`. Empty for a document-level problem. */
  path: string
  message: string
  /** 1-based position of a YAML syntax error, when known. */
  line?: number
  column?: number
}

export type ConfigValidation
  = | { ok: true, config: StatusConfig, issues: [] }
    | { ok: false, issues: ConfigIssue[] }

/** Render a Zod/JSON path (`['sites', 0, 'url']`) as `sites[0].url`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    }
    else {
      out += out ? `.${String(segment)}` : String(segment)
    }
  }
  return out
}

/**
 * Validate a `status.config.yml` document without throwing. Reports YAML syntax
 * errors (with line/column when available) and every schema error with the
 * path of the offending field. {@link parseConfig} keeps its throwing contract;
 * this is the form an editor or admin page needs.
 */
export function validateConfig(yaml: string): ConfigValidation {
  let doc: unknown
  try {
    doc = parseYaml(yaml)
  }
  catch (err) {
    const e = err as { message?: string, linePos?: Array<{ line: number, col: number }> }
    const pos = e.linePos?.[0]
    return {
      ok: false,
      issues: [{
        kind: 'syntax',
        path: '',
        message: e.message ?? 'Invalid YAML',
        ...(pos ? { line: pos.line, column: pos.col } : {}),
      }],
    }
  }
  const parsed = configSchema.safeParse(doc)
  if (parsed.success) {
    return { ok: true, config: parsed.data, issues: [] }
  }
  return {
    ok: false,
    issues: parsed.error.issues.map(issue => ({
      kind: 'schema' as const,
      path: formatIssuePath(issue.path),
      message: issue.message,
    })),
  }
}
