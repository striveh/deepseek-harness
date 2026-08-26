/**
 * Win32 native-handle query cleanup.
 * @module @deepseek-ai/dsh-native-command/windows-handle
 */

interface QuerySuccess<T> {
  readonly ok: true
  readonly value: T
}

interface QueryFailure {
  readonly ok: false
  readonly error: unknown
}

function closeFailure(close: () => number): Error | undefined {
  try {
    return close() === 0
      ? new Error('native command: CloseHandle failed after a Windows process query')
      : undefined
  } catch (error) {
    return new Error('native command: CloseHandle threw after a Windows process query', { cause: error })
  }
}

/**
 * Run one synchronous Win32 query and require its acquired handle to close.
 * @param query - query performed while the caller-owned handle is live.
 * @param close - exact `CloseHandle` call; a nonzero return means success.
 * @returns the query result after handle cleanup succeeds.
 */
export function runWindowsHandleQuery<T>(query: () => T, close: () => number): T {
  let outcome: QuerySuccess<T> | QueryFailure
  try {
    outcome = { ok: true, value: query() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  const cleanupFailure = closeFailure(close)
  if (!outcome.ok) {
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [outcome.error, cleanupFailure],
        'native command: Windows process query failed and CloseHandle also failed',
        { cause: outcome.error },
      )
    }
    throw outcome.error
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  return outcome.value
}
