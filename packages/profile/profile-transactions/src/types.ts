/**
 * Type-only vocabulary for Profile generation transactions.
 * @module @deepseek-ai/dsh-profile-transactions/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one named Profile. */
export type ProfileId = Branded<'ProfileId'>

/** Opaque identity of one immutable Profile generation. */
export type ProfileGenerationId = Branded<'ProfileGenerationId'>

/** Caller-supplied idempotency identity of one exact Profile mutation. */
export type ProfileMutationId = Branded<'ProfileMutationId'>

/** Canonical SHA-256 digest of one locally supplied package artifact. */
export type ProfileArtifactDigest = Branded<'ProfileArtifactDigest'>

/** Canonical SHA-256 digest of every effective Profile tree entry. */
export type ProfileTreeDigest = Branded<'ProfileTreeDigest'>

/** Canonical SHA-256 digest of one exact Profile-owned text file. */
export type ProfileContentDigest = Branded<'ProfileContentDigest'>

/** One exact package artifact installation or replacement. */
export interface ExactProfileArtifactMutation {
  /** Whether this is a first installation or replacement of an existing package. */
  readonly operation: 'install' | 'update'
  /** Whether the artifact must export a DSH bundle patch. */
  readonly kind: 'package' | 'bundle'
  /** Exact npm package name recorded in the generation. */
  readonly packageName: string
  /** Exact immutable SemVer recorded in the generation. */
  readonly version: string
  /** Local complete npm package archive and its caller-provided digest. */
  readonly artifact: {
    /** Absolute or working-directory-relative path to one regular `.tgz` file. */
    readonly path: string
    /** Canonical `sha256:<lowercase hex>` digest verified while staging. */
    readonly digest: ProfileArtifactDigest
  }
}

/** Exact removal of one currently installed Profile package. */
export interface ExactProfileUninstallMutation {
  readonly operation: 'uninstall'
  /** Exact npm package name removed from the generation. */
  readonly packageName: string
}

/** Exact owner-mediated replacement of the Profile patch layer. */
export interface ExactProfileConfigureMutation {
  readonly operation: 'configure'
  /** Installed package whose typed adapter owns this configuration change. */
  readonly packageName: string
  readonly patch: {
    /** Digest of the current `cordis.patch.yml` bytes. */
    readonly expectedDigest: ProfileContentDigest
    /** Fully normalized UTF-8 text produced by the package's typed adapter. */
    readonly nextUtf8: string
    /** Digest of `nextUtf8`, verified before the candidate write. */
    readonly nextDigest: ProfileContentDigest
  }
}

/** Closed P0 mutation set owned by Profile transactions. */
export type ExactProfileMutation =
  | ExactProfileArtifactMutation
  | ExactProfileUninstallMutation
  | ExactProfileConfigureMutation

/** Relationship between the active generation and the latest boot acknowledgement. */
export type ProfileBootStatus = 'live' | 'pending-restart' | 'verified'

/** Authoritative Profile snapshot plus the effective tree used by app boot. */
export interface ProfileSnapshot {
  /** Named Profile whose state was read. */
  readonly profile: ProfileId
  /** Monotonic revision used for optimistic concurrency. */
  readonly revision: number
  /** Digest fence covering the complete effective Profile tree. */
  readonly treeDigest: ProfileTreeDigest
  /** Absolute live or immutable generation directory consumed by app boot. */
  readonly effectivePath: string
  /** Active immutable generation, or `null` while the original live tree is authoritative. */
  readonly activeGeneration: ProfileGenerationId | null
  /** Latest acknowledged generation, or the captured live recovery baseline before the first acknowledgement. */
  readonly lastGoodGeneration: ProfileGenerationId | null
  /** Prior acknowledged generation available after a successful update, or `null`. */
  readonly rollbackGeneration: ProfileGenerationId | null
  /** Whether the effective tree is live, awaiting restart verification, or verified. */
  readonly bootStatus: ProfileBootStatus
}

/** Owner-validated isolated generation returned by {@link ProfileTransactions.stage}. */
export interface StagedProfileGeneration {
  readonly profile: ProfileId
  readonly mutationId: ProfileMutationId
  readonly generation: ProfileGenerationId
  readonly basedOnRevision: number
  readonly basedOnTreeDigest: ProfileTreeDigest
  readonly treeDigest: ProfileTreeDigest
  readonly mutation: ExactProfileMutation
}

/** Request to stage one exact mutation against a held revision and tree digest. */
export interface StageProfileGenerationRequest {
  readonly profile: ProfileId
  /** Caller-owned idempotency identity durably bound to the exact mutation. */
  readonly mutationId: ProfileMutationId
  readonly expectedRevision: number
  readonly expectedTreeDigest: ProfileTreeDigest
  readonly mutation: ExactProfileMutation
}

/** Request to atomically publish one validated generation. */
export interface CommitProfileGenerationRequest {
  readonly profile: ProfileId
  readonly expectedRevision: number
  readonly expectedTreeDigest: ProfileTreeDigest
  readonly generation: ProfileGenerationId
}

/** Request to discard one generation that no authoritative state names. */
export interface AbortProfileGenerationRequest {
  readonly profile: ProfileId
  readonly generation: ProfileGenerationId
}

/** Request to restore the current last-good or rollback recovery generation. */
export interface RestoreLastGoodProfileRequest {
  readonly profile: ProfileId
  /** Caller-owned idempotency identity for rollback recovery. */
  readonly mutationId: ProfileMutationId
  readonly expectedRevision: number
  readonly expectedTreeDigest: ProfileTreeDigest
}

/** Request to resolve one exact durable restore outcome by caller identity. */
export interface GetProfileRestoreReceiptRequest {
  readonly profile: ProfileId
  /** Caller-owned identity originally supplied to {@link RestoreLastGoodProfileRequest}. */
  readonly mutationId: ProfileMutationId
}

/** Request to mark the active generation verified by a successful real app boot. */
export interface AcknowledgeProfileBootRequest {
  readonly profile: ProfileId
  readonly expectedRevision: number
  readonly expectedTreeDigest: ProfileTreeDigest
  readonly generation: ProfileGenerationId
}

/** One complete generation visible for staged or recovery diagnostics. */
export interface ProfileGenerationSummary {
  readonly generation: ProfileGenerationId
  readonly treeDigest: ProfileTreeDigest
  /** Caller mutation identity, or `null` for an owner-captured baseline. */
  readonly mutationId: ProfileMutationId | null
  readonly mutation: ExactProfileMutation | null
}

/** Read-only staged and recovery inventory for one Profile. */
export interface ProfileGenerationInventory {
  readonly snapshot: ProfileSnapshot
  /** Complete summary of the active generation for caller recovery. */
  readonly active: ProfileGenerationSummary | null
  readonly staged: readonly ProfileGenerationSummary[]
  readonly recoverable: readonly ProfileGenerationSummary[]
}

/** Durable state transition produced by commit, restore, or boot acknowledgement. */
export interface ProfileCommitReceipt {
  readonly operation: 'commit' | 'restore' | 'acknowledge-boot'
  readonly before: ProfileSnapshot
  readonly after: ProfileSnapshot
  /** A committed or restored pointer takes effect only in a new app process. */
  readonly restartRequired: boolean
}

/** Exact terminal receipt retained for one committed restore mutation. */
export interface ProfileRestoreReceipt {
  readonly mutationId: ProfileMutationId
  readonly status: 'committed'
  readonly operation: 'restore'
  readonly before: ProfileSnapshot
  readonly after: ProfileSnapshot
  readonly restartRequired: true
}
