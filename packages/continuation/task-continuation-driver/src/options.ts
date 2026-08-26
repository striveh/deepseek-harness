/** Bounded Agent resume-route codec for durable continuations. @module @deepseek-ai/dsh-task-continuation-driver/src/options */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'

/** Maximum UTF-8 bytes accepted for one provider or model route identifier. */
export const MAX_CONTINUATION_ROUTE_BYTES = 256
/** Maximum output-token budget persisted for a version-1 cold resume. */
export const MAX_CONTINUATION_RESUME_TOKENS = 1_000_000

/**
 * Snapshot and validate the closed Agent route persisted for cold recovery.
 * @param options - live or caller-supplied Agent options at the authority boundary.
 * @returns a frozen copy containing only bounded provider, model, and maxTokens fields.
 */
export function normalizeContinuationAgentOptions(options: Readonly<AgentOptions>): Readonly<AgentOptions> {
  const keys = Object.keys(options)
  if (keys.some(key => key !== 'provider' && key !== 'model' && key !== 'maxTokens')) {
    throw new Error('task continuation resume options contain unsupported fields')
  }
  for (const [name, value] of [['provider', options.provider], ['model', options.model]] as const) {
    if (value !== undefined && (value === '' || Buffer.byteLength(value, 'utf8') > MAX_CONTINUATION_ROUTE_BYTES)) {
      throw new Error(`task continuation resume ${name} must be 1-${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
    }
  }
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0
      || options.maxTokens > MAX_CONTINUATION_RESUME_TOKENS)) {
    throw new Error(
      `task continuation resume maxTokens must be an integer from 1 to ${String(MAX_CONTINUATION_RESUME_TOKENS)}`,
    )
  }
  return Object.freeze({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  })
}

/**
 * Compare the complete restricted Agent route.
 * @param left - first normalized route.
 * @param right - second normalized route.
 * @returns whether all persisted route fields are identical.
 */
export function sameContinuationAgentOptions(
  left: Readonly<AgentOptions>,
  right: Readonly<AgentOptions>,
): boolean {
  return left.provider === right.provider && left.model === right.model && left.maxTokens === right.maxTokens
}
