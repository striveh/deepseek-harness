import { describe, expect, it } from 'vitest'
import {
  MAX_CONTINUATION_RESUME_TOKENS,
  MAX_CONTINUATION_ROUTE_BYTES,
  normalizeContinuationAgentOptions,
  sameContinuationAgentOptions,
} from '../src/options.ts'

describe('task continuation Agent options', () => {
  it('snapshots empty and fully populated bounded routes', () => {
    const empty = normalizeContinuationAgentOptions({})
    expect(empty).toEqual({})
    expect(Object.isFrozen(empty)).toBe(true)

    const provider = 'p'.repeat(MAX_CONTINUATION_ROUTE_BYTES)
    const complete = normalizeContinuationAgentOptions({
      provider,
      model: 'model',
      maxTokens: MAX_CONTINUATION_RESUME_TOKENS,
    })
    expect(complete).toEqual({
      provider,
      model: 'model',
      maxTokens: MAX_CONTINUATION_RESUME_TOKENS,
    })
    expect(Object.isFrozen(complete)).toBe(true)
  })

  it('rejects unsupported, empty, and overlong route fields', () => {
    expect(() => normalizeContinuationAgentOptions({ temperature: 0 } as never))
      .toThrow('unsupported fields')
    expect(() => normalizeContinuationAgentOptions({ provider: '' }))
      .toThrow(`provider must be 1-${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
    expect(() => normalizeContinuationAgentOptions({ provider: '界'.repeat(86) }))
      .toThrow(`provider must be 1-${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
    expect(() => normalizeContinuationAgentOptions({ model: '' }))
      .toThrow(`model must be 1-${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
    expect(() => normalizeContinuationAgentOptions({ model: 'm'.repeat(MAX_CONTINUATION_ROUTE_BYTES + 1) }))
      .toThrow(`model must be 1-${String(MAX_CONTINUATION_ROUTE_BYTES)} UTF-8 bytes`)
  })

  it('accepts positive integer token bounds and rejects every invalid class', () => {
    expect(normalizeContinuationAgentOptions({ maxTokens: 1 })).toEqual({ maxTokens: 1 })
    for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1,
      MAX_CONTINUATION_RESUME_TOKENS + 1]) {
      expect(() => normalizeContinuationAgentOptions({ maxTokens }))
        .toThrow(`maxTokens must be an integer from 1 to ${String(MAX_CONTINUATION_RESUME_TOKENS)}`)
    }
  })

  it('compares every persisted route field', () => {
    const route = { provider: 'provider', model: 'model', maxTokens: 128 }
    expect(sameContinuationAgentOptions(route, { ...route })).toBe(true)
    expect(sameContinuationAgentOptions(route, { ...route, provider: 'other' })).toBe(false)
    expect(sameContinuationAgentOptions(route, { ...route, model: 'other' })).toBe(false)
    expect(sameContinuationAgentOptions(route, { ...route, maxTokens: 256 })).toBe(false)
  })
})
