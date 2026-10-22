import { describe, expect, it } from 'bun:test'
import { parseConfig } from './config'
import { formatIssuePath, validateConfig } from './config-issues'

const valid = 'name: Example\nsites:\n  - name: API\n    url: https://example.com\n'

describe('validateConfig', () => {
  it('returns the parsed config and no issues for a valid document', () => {
    const result = validateConfig(valid)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config).toEqual(parseConfig(valid))
    expect(result.issues).toEqual([])
  })

  it('reports a YAML syntax error as an issue instead of throwing', () => {
    const result = validateConfig('name: Example\nsites: [unclosed\n')
    expect(result.ok).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.kind).toBe('syntax')
    expect(result.issues[0]!.line).toBeGreaterThan(0)
    expect(result.issues[0]!.message.length).toBeGreaterThan(0)
  })

  it('reports every schema error with the path of the offending field', () => {
    const result = validateConfig('name: Example\nsites:\n  - name: API\n    url: not-a-url\n  - name: Web\n    check: statuspage\n    component: ""\n    url: https://example.com\n')
    expect(result.ok).toBe(false)
    const paths = result.issues.map(i => i.path)
    expect(paths).toContain('sites[0].url')
    expect(paths).toContain('sites[1].component')
    expect(result.issues.every(i => i.kind === 'schema')).toBe(true)
  })

  it('annotates cross-field refinement errors with their path', () => {
    const result = validateConfig('name: X\nsites:\n  - name: API\n    check: sentry\n    url: https://e.com\n    component: foo\n')
    expect(result.issues.map(i => i.path)).toContain('sites[0].component')
  })

  it('reports an empty document as a root-level schema issue', () => {
    const result = validateConfig('')
    expect(result.ok).toBe(false)
    expect(result.issues[0]!.kind).toBe('schema')
    expect(result.issues[0]!.path).toBe('')
  })

  it('leaves parseConfig throwing on the same inputs', () => {
    expect(() => parseConfig('sites: [unclosed')).toThrow()
    expect(() => parseConfig('name: X\n')).toThrow()
  })
})

describe('formatIssuePath', () => {
  it('renders indices in brackets and keys with dots', () => {
    expect(formatIssuePath(['sites', 0, 'sentry', 'org'])).toBe('sites[0].sentry.org')
    expect(formatIssuePath([])).toBe('')
  })
})
