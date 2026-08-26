# Profile Generation Transactions

English | [中文](profile-transactions.zh.md)

The Profile transaction seam owns complete immutable Profile generations and the pointer selected by the next app boot. [`dsh-profile-transactions`](../../packages/profile/profile-transactions) is the Service Definition; [`dsh-profile-transactions-local`](../../packages/profile/profile-transactions-local) is the local Provider; the product CLI and runtime Extension Center are Consumers. The capability stays outside the agent loop and contributes no model-visible state.

Source: [`packages/profile/profile-transactions/src/types.ts`](../../packages/profile/profile-transactions/src/types.ts)

## State and conflict fences

`ProfileSnapshot` contains a monotonic revision, complete effective-tree digest, effective directory, active generation, last-good generation, rollback generation, and `live`, `pending-restart`, or `verified` boot status. Every stage, commit, restore, and boot acknowledgement carries both the held revision and held tree digest. Stage and restore additionally carry a caller mutation id: exact retries return the same generation or receipt, while reuse with different immutable input fails. Competing publication, external tree edits, stale configure bytes, and caller-key conflicts are distinct errors; none uses last-write-wins behavior. Dynamic Consumers require `instanceof ProfileTransactions` and `protocolVersion === 1`.

`getRestoreReceipt({ profile, mutationId })` resolves one exact terminal restore without choosing a target. A committed result binds the caller id, original before/after snapshots, target generation/tree digest, and required-restart state; absence returns `null`.

The tree digest covers sorted directory entries, regular-file bytes and executable bits, plus internal symlink targets. The launcher-owned `cordis.yml`, transaction metadata, and runtime scratch are excluded. A generation otherwise contains the full bootable Profile: manifest, bundle list, patch, workspace settings, pnpm lockfile, retained archives, and real installed package files.

## Mutation lifecycle

P0 accepts one exact mutation per generation. Install/update accepts an already-local `.tgz`, package kind, exact name/version, and caller SHA-256. Uninstall names an installed package. Configure names an installed package whose typed adapter produced an exact replacement for Profile-root `cordis.patch.yml`, with current and next content digests plus normalized next UTF-8 bytes. The owner does not parse YAML and cannot target another file.

Staging copies the complete effective Profile, checks that the copy still matches the held tree, applies the mutation, updates `package.json`, ordered bundles, real package files, retained artifact, and pnpm importer/package/snapshot records as one candidate, and invokes the local Provider's isolated validator. The public Service accepts no validation callback. Validation failure, candidate modification, or lock inconsistency removes the candidate without changing authority.

The local Provider starts a detached bounded child through the CLI's hidden argv router, loads the candidate read-only, composes its real patch layers, boots the real Web Loader on loopback port zero, and disposes it. The synthetic `cordis.yml` lives in the disposable validation home while an explicit Loader base URL remains the candidate Profile root, so validation does not write the staged tree and relative entries keep production semantics. P0 fails loud for non-Web candidate validation. The parent bounds output and time and kills the child process tree on failure.

The validator child inherits only process-launch, locale, and temporary-directory environment names. Harness state, credential-shaped names, credential-file pointers, provider endpoint overrides, proxies, SSH-agent authority, Node injection options, and every other ambient name are omitted; the child replaces its home, Harness home, XDG, application-data, and temporary directories with one disposable directory before candidate activation. This is credential minimization, not a filesystem or network sandbox. Admitted candidate code still runs with the host user's operating-system authority and can address host paths or the network, so trust policy and human approval must precede validation.

## Publication, boot, and restore

The first commit captures the original live Profile as an immutable baseline and last-good recovery target. The candidate becomes active with `pending-restart`; no transaction changes the effective tree of the process that published it. On the next launch, a short-lived pre-Loader Consumer resolves the active generation, copies it into an invocation-private runtime root, verifies the copy against the selected tree digest, loads that copy, and confirms the same transaction snapshot before Loader activation. The private copy is Loader's relative-entry base, so later replacement of the authoritative generation cannot supply imported bytes. Each runtime root records its owner PID and process incarnation; later preparation removes exact dead-owner and PID-reuse residue while preserving live sibling invocations.

A CLI first install may run before ordinary Web Profile boot. After initializing the shipped Web template and before staging, the CLI heals the installation-owned `profiles/node_modules` fallback with the same app-boot authority, so the real validator resolves the standard base and Web rows exactly as the subsequent product launch does.

After the real app Loader activates, the bootstrap Consumer acknowledges the exact generation/revision/tree and then disposes. Only that acknowledgement promotes the generation to `verified` last-good and moves the former last-good to rollback. A failed boot leaves last-good unchanged. Restore selects last-good for an unverified active generation, or rollback after a verified generation, and also requires restart.

Managed generation patch files are not watched or re-read for HMR. The home-level patch remains live, while a Profile configuration change must create and validate another generation. External generation edits trip the next whole-tree fence instead of becoming an authorized hot update.

## Dual composition and recovery

The CLI mounts `LocalProfileTransactions` in a short-lived bootstrap Context before the main Loader. `dsh-base` mounts a second instance at runtime with `profilesDir: dshHomePath('profiles')` for Extension Center requests. Both use the same per-Profile SQLite reservation and journal. The runtime Provider can publish only the next process's pointer and cannot change the current process's effective path.

Pointer writers use short SQLite `BEGIN IMMEDIATE` transactions. A stage transaction first reserves its caller mutation id, then releases SQLite while the owner builds and validates the complete generation, and finally marks that exact generation complete in another short transaction. A dead builder can be recovered under the same key; a live concurrent builder is awaited. Pointer publication verifies every generation named by the next state, flushes the journal, replaces and flushes state, then removes the journal. Restore records the mutation id and exact transition receipt. Receipt lookup takes the writer reservation and completes a correlated durable journal, so process death after state fsync but before receipt persistence returns the original result without another revision. Snapshot/list remain read-only and project a valid durable journal; the next mutation or exact receipt lookup completes recovery. Malformed or unrelated state fails rather than guessing.

## P0 limits

P0 archives may not declare regular, optional, or bundled dependencies, installation lifecycle scripts, or `bin` entries. The isolated product validator admits Web Profiles only and does not provide operating-system filesystem or network confinement. Multi-package graph transactions, automatic generation pruning, online discovery, trust decisions, approval UX, restart orchestration, and original-task continuation belong to later layers or Consumers.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprofiletransactions--profiletransactions-abstract-seam"></a>

### `ctx.profileTransactions` — `ProfileTransactions` (abstract seam)

Transaction owner for complete named Profile generations.

```ts cordis-catalog
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
```

Source: [`packages/profile/profile-transactions/src/index.ts`](../../packages/profile/profile-transactions/src/index.ts)
<!-- END GENERATED cordis-surface -->
