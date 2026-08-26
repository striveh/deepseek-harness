/**
 * Service Definition for complete Profile generation transactions. A provider
 * stages one exact mutation against a full Profile tree, validates it, and
 * atomically publishes, verifies, or restores immutable generations.
 * @module @deepseek-ai/dsh-profile-transactions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AbortProfileGenerationRequest,
  AcknowledgeProfileBootRequest,
  CommitProfileGenerationRequest,
  GetProfileRestoreReceiptRequest,
  ProfileArtifactDigest,
  ProfileContentDigest,
  ProfileCommitReceipt,
  ProfileGenerationInventory,
  ProfileId,
  ProfileMutationId,
  ProfileRestoreReceipt,
  ProfileSnapshot,
  ProfileTreeDigest,
  RestoreLastGoodProfileRequest,
  StageProfileGenerationRequest,
  StagedProfileGeneration,
} from './types.ts'

export type {
  AbortProfileGenerationRequest,
  AcknowledgeProfileBootRequest,
  CommitProfileGenerationRequest,
  ExactProfileArtifactMutation,
  ExactProfileConfigureMutation,
  ExactProfileMutation,
  ExactProfileUninstallMutation,
  GetProfileRestoreReceiptRequest,
  ProfileArtifactDigest,
  ProfileBootStatus,
  ProfileCommitReceipt,
  ProfileContentDigest,
  ProfileGenerationId,
  ProfileGenerationInventory,
  ProfileGenerationSummary,
  ProfileId,
  ProfileMutationId,
  ProfileRestoreReceipt,
  ProfileSnapshot,
  ProfileTreeDigest,
  RestoreLastGoodProfileRequest,
  StageProfileGenerationRequest,
  StagedProfileGeneration,
} from './types.ts'

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TRANSACTION_ROOT = '.dsh-profile-transactions'

/** Maximum exact UTF-8 Profile patch payload admitted by protocol version 1. */
export const MAX_PROFILE_PATCH_BYTES = 1024 * 1024

/**
 * Validate and brand a Profile name.
 * @param value - raw Profile name.
 * @returns the branded name.
 */
export function profileId(value: string): ProfileId {
  if (value === '' || value.includes('/') || value.includes('\\') || value === '.' || value === '..'
    || value === 'node_modules' || value === TRANSACTION_ROOT) {
    throw new TypeError(`profile name ${JSON.stringify(value)} must be one non-reserved path segment`)
  }
  return value as ProfileId
}

/**
 * Validate and brand one caller-owned Profile mutation identity.
 * @param value - bounded opaque identifier safe for durable diagnostics.
 * @returns the branded mutation identity.
 */
export function profileMutationId(value: string): ProfileMutationId {
  if (!MUTATION_ID.test(value)) {
    throw new TypeError('profile mutation id must be 1-128 safe identifier characters')
  }
  return value as ProfileMutationId
}

function sha256Digest(value: string, label: string): string {
  if (!SHA256_DIGEST.test(value)) throw new TypeError(`${label} must match sha256:<64 lowercase hex>`)
  return value
}

/**
 * Validate and brand one canonical artifact digest.
 * @param value - expected `sha256:<64 lowercase hex>` digest.
 * @returns the branded digest.
 */
export function profileArtifactDigest(value: string): ProfileArtifactDigest {
  return sha256Digest(value, 'profile artifact digest') as ProfileArtifactDigest
}

/**
 * Validate and brand one canonical Profile file-content digest.
 * @param value - expected `sha256:<64 lowercase hex>` digest.
 * @returns the branded digest.
 */
export function profileContentDigest(value: string): ProfileContentDigest {
  return sha256Digest(value, 'profile content digest') as ProfileContentDigest
}

/**
 * Validate and brand one canonical complete-tree digest.
 * @param value - expected `sha256:<64 lowercase hex>` digest.
 * @returns the branded digest.
 */
export function profileTreeDigest(value: string): ProfileTreeDigest {
  return sha256Digest(value, 'profile tree digest') as ProfileTreeDigest
}

/** A transition refused because another transaction published first. */
export class ProfileRevisionConflictError extends Error {
  /** Stable machine-readable conflict class. */
  readonly code = 'PROFILE_REVISION_CONFLICT' as const

  constructor(
    readonly profile: ProfileId,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`profile ${JSON.stringify(profile)} changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'ProfileRevisionConflictError'
  }
}

/** A transition refused because the effective Profile tree was edited outside the owner. */
export class ProfileTreeConflictError extends Error {
  /** Stable machine-readable conflict class. */
  readonly code = 'PROFILE_TREE_CONFLICT' as const

  constructor(
    readonly profile: ProfileId,
    readonly expected: ProfileTreeDigest,
    readonly actual: ProfileTreeDigest,
  ) {
    super(`profile ${JSON.stringify(profile)} tree changed since it was read (expected ${expected}, now ${actual})`)
    this.name = 'ProfileTreeConflictError'
  }
}

/** A configure mutation refused because the Profile patch bytes changed. */
export class ProfileContentConflictError extends Error {
  /** Stable machine-readable conflict class. */
  readonly code = 'PROFILE_CONTENT_CONFLICT' as const

  constructor(
    readonly profile: ProfileId,
    readonly expected: ProfileContentDigest,
    readonly actual: ProfileContentDigest,
  ) {
    super(`profile ${JSON.stringify(profile)} patch changed since it was read (expected ${expected}, now ${actual})`)
    this.name = 'ProfileContentConflictError'
  }
}

/** A caller mutation identity was already bound to different immutable input. */
export class ProfileMutationConflictError extends Error {
  /** Stable machine-readable conflict class. */
  readonly code = 'PROFILE_MUTATION_CONFLICT' as const

  constructor(
    readonly profile: ProfileId,
    readonly mutationId: ProfileMutationId,
  ) {
    super(`profile ${JSON.stringify(profile)} mutation ${JSON.stringify(mutationId)} is already bound to different input`)
    this.name = 'ProfileMutationConflictError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    profileTransactions: ProfileTransactions
  }
}

/** Transaction owner for complete named Profile generations. */
export abstract class ProfileTransactions extends Service {
  /** Exact same-process API revision required by dynamic consumers. */
  abstract readonly protocolVersion: 1

  constructor(ctx: Context) {
    super(ctx, 'profileTransactions')
  }

  /**
   * Read the authoritative state and complete effective-tree digest without writing.
   * @param profile - Profile to inspect.
   * @returns the state and effective directory app boot must consume.
   */
  abstract snapshot(profile: ProfileId): Promise<ProfileSnapshot>

  /**
   * Build a complete isolated candidate and run the Provider-owned real activation validator.
   * @param request - semantic mutation identity and fences for its first execution; a completed equivalent identity may carry newer fences.
   * @returns the newly validated or durably replayed original generation handle.
   */
  abstract stage(request: StageProfileGenerationRequest): Promise<StagedProfileGeneration>

  /**
   * Publish one validated generation; its activation requires process restart.
   * @param request - generation and current fences for first publication; a completed generation may carry newer fences.
   * @returns the new or durably replayed original transition receipt.
   */
  abstract commit(request: CommitProfileGenerationRequest): Promise<ProfileCommitReceipt>

  /**
   * Remove one generation that no authoritative state names.
   * @param request - exact Profile and generation to discard.
   * @returns whether a generation directory was removed.
   */
  abstract abort(request: AbortProfileGenerationRequest): Promise<boolean>

  /**
   * Publish the appropriate last-good or rollback recovery generation.
   * @param request - Profile and both current conflict fences.
   * @returns the durable transition receipt.
   */
  abstract restoreLastGood(request: RestoreLastGoodProfileRequest): Promise<ProfileCommitReceipt>

  /**
   * Resolve a retained restore outcome, completing an already durable journal if process death interrupted receipt publication.
   * @param request - exact Profile and caller mutation identity to query.
   * @returns the original committed receipt, or `null` when that identity has no restore transaction.
   */
  abstract getRestoreReceipt(request: GetProfileRestoreReceiptRequest): Promise<ProfileRestoreReceipt | null>

  /**
   * Promote the active generation only after the real app Loader boot succeeds.
   * @param request - exact active generation and both current conflict fences.
   * @returns the durable verification receipt.
   */
  abstract acknowledgeBoot(request: AcknowledgeProfileBootRequest): Promise<ProfileCommitReceipt>

  /**
   * List complete staged and recovery generations without changing disk state.
   * @param profile - Profile to inspect.
   * @returns current snapshot plus staged and recoverable generations.
   */
  abstract list(profile: ProfileId): Promise<ProfileGenerationInventory>
}

export default ProfileTransactions
