import type { CheckResult } from './types'

/**
 * Tells a host limit from a target failure by looking at what the injected
 * fetch threw. Returns the limit it recognises, or `undefined` for an ordinary
 * failure. The host's wording stays with the caller, not in core.
 */
export type ErrorClassifier = (error: unknown) => 'body' | undefined

/** Spread this into a failed {@link CheckResult} to carry a recognised host limit. */
export function limitOf(classify: ErrorClassifier | undefined, error: unknown): Pick<CheckResult, 'limit'> {
  const limit = classify?.(error)
  return limit ? { limit } : {}
}
