import { describe, expect, it } from 'bun:test'
import { advanceMonitor, MAX_STORED_ERROR_LENGTH } from '../src/snapshot'

const NOW = new Date('2026-06-30T12:00:00Z')

function advance(error?: string) {
  const result = { slug: 'web', status: 'down' as const, code: 0, responseTime: 1, checkedAt: NOW.toISOString(), ...(error === undefined ? {} : { error }) }
  return advanceMonitor(undefined, result, [], NOW).result
}

describe('advanceMonitor error cap', () => {
  it('truncates a 20,000-character error to the cap with a visible marker', () => {
    const error = advance('x'.repeat(20_000))?.error
    expect(error).toHaveLength(MAX_STORED_ERROR_LENGTH)
    expect(error).toBe(`${'x'.repeat(MAX_STORED_ERROR_LENGTH - 1)}…`)
  })

  it('leaves a short error, and a missing one, unchanged', () => {
    expect(advance('connection refused')?.error).toBe('connection refused')
    expect(advance('y'.repeat(MAX_STORED_ERROR_LENGTH))?.error).toBe('y'.repeat(MAX_STORED_ERROR_LENGTH))
    expect(advance()).not.toHaveProperty('error')
  })

  it('does not split a surrogate pair at the cut', () => {
    const error = advance('a'.repeat(MAX_STORED_ERROR_LENGTH - 2) + '😀'.repeat(10))?.error as string
    expect(error.endsWith('…')).toBe(true)
    expect(error).toBe(`${'a'.repeat(MAX_STORED_ERROR_LENGTH - 2)}…`)
  })
})
