/** Strict validation and fixed message framing for task-continuation records. @module @deepseek-ai/dsh-task-continuation */

import { randomUUID } from 'node:crypto'
import { freezeMessage, MessageId, type MessageSource, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuationCallerId,
  ContinuationDigest,
  ContinuationId,
  ContinuationMutationId,
  TaskContinuationClaim,
  TaskContinuationMessageSource,
  TaskContinuationRevision,
  TaskContinuationVerifierId,
} from './types.ts'

/** Exact model-facing prompt for a verified continuation dispatch. */
export const TASK_CONTINUATION_PROMPT = 'The requested capability is now verified for the existing task. Re-check it and continue that task.'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const VERIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const TASK_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MUTATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/** Stable input rejection at the continuation API boundary. */
export class TaskContinuationInputError extends Error {
  /** Stable machine-readable rejection code. */
  readonly code = 'TASK_CONTINUATION_INVALID_INPUT'
}

/** Stable rejection when one caller key is replayed with different immutable input. */
export class TaskContinuationMutationConflictError extends Error {
  /** Stable machine-readable rejection code. */
  readonly code = 'TASK_CONTINUATION_MUTATION_CONFLICT'

  /**
   * @param callerId - conflicting caller namespace.
   * @param mutationId - conflicting caller-scoped operation identity.
   */
  constructor(callerId: ContinuationCallerId, mutationId: ContinuationMutationId) {
    super(`task continuation mutation "${callerId}/${mutationId}" is already bound to different input`)
  }
}

/**
 * Brand a caller- or store-supplied continuation identity.
 * @param id - non-empty UUID string.
 * @returns the same value with the continuation brand.
 */
export function continuationId(id: string): ContinuationId {
  if (!isUuid(id)) throw new TaskContinuationInputError('continuation id must be a UUID')
  return id as ContinuationId
}

/**
 * Allocate a fresh continuation identity.
 * @returns a random UUID with the continuation brand.
 */
export function allocateContinuationId(): ContinuationId {
  return continuationId(randomUUID())
}

/**
 * Validate and brand one stable caller namespace.
 * @param id - 1-128 lower-kebab characters.
 * @returns the unchanged caller identity.
 */
export function taskContinuationCallerId(id: string): ContinuationCallerId {
  if (id.length > 128 || !VERIFIER_PATTERN.test(id)) {
    throw new TaskContinuationInputError('continuation caller id must be 1-128 lower-kebab characters')
  }
  return id as ContinuationCallerId
}

/**
 * Validate and brand one caller-scoped mutation identity.
 * @param id - bounded opaque identifier safe for durable diagnostics.
 * @returns the unchanged mutation identity.
 */
export function taskContinuationMutationId(id: string): ContinuationMutationId {
  if (!MUTATION_PATTERN.test(id)) {
    throw new TaskContinuationInputError('continuation mutation id must be 1-128 safe identifier characters')
  }
  return id as ContinuationMutationId
}

/**
 * Validate and brand one canonical SHA-256 digest.
 * @param digest - `sha256:` followed by 64 lower-case hexadecimal digits.
 * @returns the validated digest with its continuation brand.
 */
export function continuationDigest(digest: string): ContinuationDigest {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new TaskContinuationInputError('continuation digest must use canonical lower-case SHA-256 syntax')
  }
  return digest as ContinuationDigest
}

/**
 * Validate one task revision fence.
 * @param revision - bounded opaque revision safe for durable diagnostics.
 * @returns the unchanged validated revision.
 */
export function taskContinuationRevision(revision: string): TaskContinuationRevision {
  if (!TASK_REVISION_PATTERN.test(revision)) {
    throw new TaskContinuationInputError('task revision must be 1-128 safe identifier characters')
  }
  return revision as TaskContinuationRevision
}

/**
 * Validate one verifier registration identity.
 * @param id - lower-kebab verifier identifier.
 * @returns the unchanged validated verifier identity.
 */
export function taskContinuationVerifierId(id: string): TaskContinuationVerifierId {
  if (id.length > 128 || !VERIFIER_PATTERN.test(id)) {
    throw new TaskContinuationInputError('verifier id must be 1-128 lower-kebab characters')
  }
  return id as TaskContinuationVerifierId
}

/**
 * Construct the exact recoverable message for a claim.
 * @param claim - durable claim whose message identity and source are preserved.
 * @returns a deeply frozen user message containing no original task text.
 */
export function taskContinuationMessage(claim: TaskContinuationClaim): UserMessage {
  return freezeMessage({
    id: MessageId(claim.dispatchMessageId),
    role: 'user',
    content: [{ type: 'text', text: TASK_CONTINUATION_PROMPT }],
    source: taskContinuationSource(claim),
  })
}

/**
 * Parse a merge-extensible message source as an exact continuation source.
 * @param source - source value crossing an inbox or session boundary.
 * @returns the strict source, or `undefined` for another source kind or invalid fields.
 */
export function decodeTaskContinuationSource(source: MessageSource): TaskContinuationMessageSource | undefined {
  if (source.kind !== 'task-continuation') return undefined
  const value = source as unknown
  if (!isRecord(value) || !hasExactKeys(value, [
    'kind', 'version', 'continuationId', 'sessionId', 'originalMessageId', 'needDigest',
    'taskRevision', 'verifierId', 'verificationPayloadDigest', 'expiresAtMs',
  ])) return undefined
  try {
    if (value['kind'] !== 'task-continuation' || value['version'] !== 1) return undefined
    if (typeof value['continuationId'] !== 'string' || typeof value['sessionId'] !== 'string'
      || typeof value['originalMessageId'] !== 'string' || typeof value['needDigest'] !== 'string'
      || typeof value['taskRevision'] !== 'string' || typeof value['verifierId'] !== 'string'
      || typeof value['verificationPayloadDigest'] !== 'string'
      || !isEpochMs(value['expiresAtMs'])) return undefined
    return {
      kind: 'task-continuation',
      version: 1,
      continuationId: continuationId(value['continuationId']),
      sessionId: SessionId(value['sessionId']),
      originalMessageId: MessageId(value['originalMessageId']),
      needDigest: continuationDigest(value['needDigest']),
      taskRevision: taskContinuationRevision(value['taskRevision']),
      verifierId: taskContinuationVerifierId(value['verifierId']),
      verificationPayloadDigest: continuationDigest(value['verificationPayloadDigest']),
      expiresAtMs: value['expiresAtMs'],
    }
  } catch (_invalid: unknown) {
    // Every field validator above throws only for an invalid durable source.
    return undefined
  }
}

/**
 * Compare a message to the canonical content, identity, and source for a claim.
 * @param message - parked or submitted inbox message.
 * @param claim - authoritative durable claim.
 * @returns whether every dispatch-bearing field matches.
 */
export function isTaskContinuationMessage(message: UserMessage, claim: TaskContinuationClaim): boolean {
  if (message.id !== claim.dispatchMessageId
    || message.content.length !== 1 || message.content[0]?.type !== 'text'
    || message.content[0].text !== TASK_CONTINUATION_PROMPT) return false
  const source = decodeTaskContinuationSource(message.source)
  return source !== undefined
    && source.continuationId === claim.continuationId
    && source.sessionId === claim.sessionId
    && source.originalMessageId === claim.originalMessageId
    && source.needDigest === claim.needDigest
    && source.taskRevision === claim.taskRevision
    && source.verifierId === claim.verifierId
    && source.verificationPayloadDigest === claim.verificationPayloadDigest
    && source.expiresAtMs === claim.expiresAtMs
}

/** Select only the fields persisted in message attribution. */
function taskContinuationSource(claim: TaskContinuationClaim): TaskContinuationMessageSource {
  return {
    kind: 'task-continuation',
    version: 1,
    continuationId: claim.continuationId,
    sessionId: claim.sessionId,
    originalMessageId: claim.originalMessageId,
    needDigest: claim.needDigest,
    taskRevision: claim.taskRevision,
    verifierId: claim.verifierId,
    verificationPayloadDigest: claim.verificationPayloadDigest,
    expiresAtMs: claim.expiresAtMs,
  }
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/** Whether a record owns exactly the expected keys. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

/** Whether a number is a finite non-negative epoch-millisecond integer. */
function isEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Whether a string is an RFC 4122 UUID accepted by `crypto.randomUUID`. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
