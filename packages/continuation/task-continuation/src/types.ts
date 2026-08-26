/** Public values for durable task-continuation claims. @module @deepseek-ai/dsh-task-continuation */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

/** Stable identity of one single-use continuation claim. */
export type ContinuationId = Branded<'ContinuationId'>

/** Stable identity of a continuation-reserving caller. */
export type ContinuationCallerId = Branded<'ContinuationCallerId'>

/** Caller-scoped idempotency identity of one reservation mutation. */
export type ContinuationMutationId = Branded<'ContinuationMutationId'>

/** Canonical lower-case SHA-256 digest used at continuation trust boundaries. */
export type ContinuationDigest = Branded<'ContinuationDigest'>

/** Caller-owned revision fence for one original or replacement task. */
export type TaskContinuationRevision = Branded<'TaskContinuationRevision'>

/** Stable identity of one continuation evidence verifier. */
export type TaskContinuationVerifierId = Branded<'TaskContinuationVerifierId'>

/** Durable lifecycle: `consumed` is leaseable intent; `claimed` is the pre-provider at-most-once barrier. */
export type TaskContinuationState =
  | 'pending'
  | 'ready'
  | 'consumed'
  | 'claimed'
  | 'canceled'
  | 'superseded'
  | 'expired'
  | 'invalid'

/** States from which the driver may still establish or recover one dispatch. */
export type ActiveTaskContinuationState = Extract<TaskContinuationState, 'pending' | 'ready' | 'consumed'>

/** Strict version-1 attribution carried by the fixed continuation message. */
export interface TaskContinuationMessageSource {
  readonly kind: 'task-continuation'
  readonly version: 1
  readonly continuationId: ContinuationId
  readonly sessionId: SessionId
  readonly originalMessageId: MessageId
  readonly needDigest: ContinuationDigest
  readonly taskRevision: TaskContinuationRevision
  readonly verifierId: TaskContinuationVerifierId
  readonly verificationPayloadDigest: ContinuationDigest
  readonly expiresAtMs: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-continuation': TaskContinuationMessageSource
  }
}

/** Complete immutable public view of one durable claim. */
export interface TaskContinuationClaim extends TaskContinuationMessageSource {
  /** Stable owner namespace for reservation reconciliation. */
  readonly callerId: ContinuationCallerId
  /** Caller-scoped idempotency identity of the creating mutation. */
  readonly mutationId: ContinuationMutationId
  /** Monotonic compare-and-set revision of the durable claim record. */
  readonly recordRevision: number
  /** Stable identity of the recoverable pre-barrier next-turn message. */
  readonly dispatchMessageId: MessageId
  /** Exact Agent options needed to cold-resume the original model route. */
  readonly resumeAgentOptions: Readonly<AgentOptions>
  /** Current durable lifecycle state. */
  readonly state: TaskContinuationState
  /** Epoch milliseconds at which the claim was accepted. */
  readonly createdAtMs: number
  /** Epoch milliseconds of the latest durable transition. */
  readonly updatedAtMs: number
  /** Replacement revision recorded by a supersede transition. */
  readonly supersededByTaskRevision?: TaskContinuationRevision
}

/** Inputs whose acceptance creates one parked, durable continuation. */
export interface CreateTaskContinuationRequest {
  /** Stable lower-kebab caller namespace. */
  readonly callerId: ContinuationCallerId
  /** Caller-scoped exact idempotency key. */
  readonly mutationId: ContinuationMutationId
  /** Exact live session that owns the original task. */
  readonly sessionId: SessionId
  /** Identified direct-user message that established the original task. */
  readonly originalMessageId: MessageId
  /** Canonical digest of the capability gap, without the task text. */
  readonly needDigest: ContinuationDigest
  /** Caller-owned revision fence for the original task. */
  readonly taskRevision: TaskContinuationRevision
  /** Registered verifier responsible for the external completion evidence. */
  readonly verifierId: TaskContinuationVerifierId
  /** Canonical digest of the verifier-owned payload or receipt. */
  readonly verificationPayloadDigest: ContinuationDigest
  /** Finite epoch-millisecond deadline after which dispatch is forbidden. */
  readonly expiresAtMs: number
}

/** Cold-safe reservation input containing the exact Agent route needed to reopen the Session. */
export interface ReserveTaskContinuationRequest extends CreateTaskContinuationRequest {
  /** Restricted provider, model, and token options used to resume an absent Agent. */
  readonly resumeAgentOptions: Readonly<AgentOptions>
}

/** Exact caller fence for cancel and supersede mutations. */
export interface TaskContinuationRef {
  readonly id: ContinuationId
  readonly sessionId: SessionId
  readonly taskRevision: TaskContinuationRevision
}

/** Optional exact-session filter for management listing. */
export interface ListTaskContinuationsRequest {
  readonly sessionId?: SessionId
  /** Optional caller namespace for operation reconciliation. */
  readonly callerId?: ContinuationCallerId
  /** Optional caller-scoped mutation identity for exact reconciliation. */
  readonly mutationId?: ContinuationMutationId
}

/** Replacement fence recorded while making an older claim terminal. */
export interface SupersedeTaskContinuationRequest extends TaskContinuationRef {
  readonly replacementTaskRevision: TaskContinuationRevision
}

/** Verifier decision that leaves a claim parked without mutation. */
export interface TaskContinuationNotReady {
  readonly kind: 'not-ready'
}

/** Positive verifier result echoing every authority-bearing claim field. */
export interface TaskContinuationReady {
  readonly kind: 'ready'
  readonly continuationId: ContinuationId
  readonly sessionId: SessionId
  readonly originalMessageId: MessageId
  readonly needDigest: ContinuationDigest
  readonly taskRevision: TaskContinuationRevision
  readonly verificationPayloadDigest: ContinuationDigest
}

/** Result returned by one registered continuation verifier. */
export type TaskContinuationVerification = TaskContinuationNotReady | TaskContinuationReady

/** Same-process verifier for extension-owned evidence identified only by digest. */
export interface TaskContinuationVerifier {
  /** Stable lower-kebab identifier stored in claims. */
  readonly id: TaskContinuationVerifierId
  /**
   * Check the exact evidence binding without installing or mutating capabilities.
   * @param claim - immutable claim whose external receipt must be checked.
   * @param signal - cancellation for provider unload or agent teardown.
   * @returns a parked or fully echoed positive decision.
   */
  verify(claim: TaskContinuationClaim, signal: AbortSignal): Promise<TaskContinuationVerification>
}
