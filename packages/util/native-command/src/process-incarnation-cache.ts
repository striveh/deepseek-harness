/**
 * Process-incarnation cache decisions independent of host inspection.
 * @module @deepseek-ai/dsh-native-command/process-incarnation-cache
 */

import type { ProcessIncarnation } from './index.ts'

/** Mutable cache cell owned by one process-incarnation consumer. */
export interface ProcessIncarnationCache {
  /** Resolved process identity after the first successful read. */
  value?: ProcessIncarnation
}

/**
 * Resolve a non-null process identity once and retain it in the supplied cell.
 * @param cache - caller-owned cache cell.
 * @param read - uncached host identity read.
 * @returns the cached or newly read process identity.
 */
export function cachedProcessIncarnation(
  cache: ProcessIncarnationCache,
  read: () => ProcessIncarnation | null,
): ProcessIncarnation {
  if (cache.value !== undefined) return cache.value
  const value = read()
  if (value === null) {
    throw new Error('current process disappeared during incarnation inspection')
  }
  cache.value = value
  return value
}
