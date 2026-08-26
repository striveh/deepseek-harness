# @deepseek-ai/dsh-profile-transactions-local

English | [中文](README.zh.md)

Local Provider for [`ctx.profileTransactions`](../profile-transactions/README.md). It stores immutable complete Profile generations under `profilesDir/.dsh-profile-transactions/<profile>/`, uses SQLite `BEGIN IMMEDIATE` as a process-owned cross-process writer reservation, and publishes pointer transitions through a durable JSON journal.

Provider activation validates the required absolute `installAnchor` but does not import SQLite or create transaction state. Snapshot and list remain filesystem-only; the first writer imports SQLite, preserving clean read-only CLI output on Node releases that still label `node:sqlite` experimental.

The package also exports the provider-owned `copyProfileTree(sourceRoot, targetRoot)` and `digestProfileTree(root)` filesystem primitives. Both cover the same complete-tree entries, executable bits, and internal-link targets while excluding transaction and runtime scratch; the CLI uses them together to materialize and verify an invocation-private Loader tree from an active generation.

The provider is intentionally mounted twice in the product. A short-lived pre-Loader Context resolves and acknowledges the tree used by the current CLI process. The `dsh-base` Context mounts another instance for runtime Extension Center requests. Both instances share the same files and SQLite reservation; the runtime instance may publish only the next process's active pointer and cannot change its own effective tree.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `profilesDir` | string | required | Directory whose direct children are named live Profiles |
| `installAnchor` | string | none | Exact application package file used by owner-managed Loader validation; mutation fails loud when absent |
| `lockWaitMs` | non-negative integer | `10000` | Maximum wait for another process's Profile writer reservation |
| `validationTimeoutMs` | integer from `1` through `2147483647` | `30000` | Wall-clock budget for isolated Loader activation and disposal |

## Complete generations

Every generation contains `package.json`, ordered `dsh.profile.bundles`, `cordis.patch.yml`, `pnpm-workspace.yaml`, owner-maintained `pnpm-lock.yaml`, retained `.dsh-artifacts` archives, and real package files under `node_modules`. Install, update, and uninstall change the manifest, bundle list, package files, retained archive, root importer, package snapshot, and integrity metadata together. Compressed input and declared extracted content each have a 100 MiB limit; both the initial file size and bytes observed while copying are bounded. A malformed or stale lockfile fails before staging or authority publication.

P0 archive admission verifies exact name, exact SemVer, caller SHA-256, archive paths/types/limits, bundle declaration, and the absence of dependencies, install lifecycle scripts, and `bin` entries. Numeric prerelease identifiers with leading zeroes are not exact SemVer. For a package that is a current direct `dsh.profile.bundles` member or would become one through bundle install/update, the owner uses the exact `installAnchor` lookup that app-boot places first. An installation-resolved conflict fails before the first staging reservation, candidate creation, archive read, or Loader validation, and completed mutation replay repeats the ownership check before returning its durable generation. Archive-entry preflight and extraction each keep cumulative entry and byte state; rejection is captured inside the reader callback and returned through the `stage()` Promise, so an unsafe or concurrently rewritten copied archive fails closed without an uncaught callback error or a pending stage. Dependency maps use own-key membership and null-prototype mutation, so package names that overlap Object prototype names retain ordinary package semantics in the manifest and lockfile. Configure can change only root `cordis.patch.yml`; it requires an installed owner package, normalized UTF-8/LF/trailing-newline bytes, content digests, and the complete-tree fence. The Provider synchronously detaches every mutation and transition request before its first asynchronous store operation. `stage` itself runs the Provider-owned real composition validator; no Consumer callback can replace it. `validationTimeoutMs` bounds that child activation and disposal without relying on Node's overflow-clamped timer range. The validator settles from child `close` after stdio drains. If output-limit or timeout handling cannot terminate the process tree, the parent destroys both stdio pipes and unreferences the child before rejecting, so the original failure remains first in the aggregate without retaining event-loop handles; independent termination and local-release failures follow it in operation order.

## Publication and recovery

The first commit copies the original live Profile into an immutable baseline and names it last-good before publishing the candidate pending restart. A failed pre-publication commit removes that baseline only after confirming that neither state nor journal names it. `acknowledgeBoot` promotes a generation only after the real app Loader succeeds. Restore selects last-good while an active generation is unverified, otherwise the prior verified rollback generation. Revision and tree fences constrain the first execution. After commit, the same Profile, mutation id, and semantic mutation replay the original staged generation and commit receipt across newer fences; artifact transport paths are not part of that identity, while any semantic change conflicts. Commit and restore retain their correlated journal until SQLite holds the exact before/after receipt. `getRestoreReceipt` takes the same writer reservation, completes any correlated durable journal, and returns the exact committed restore or `null` without selecting a new target. A writer killed after state fsync but before receipt persistence is therefore recovered by receipt lookup or mutation retry, neither of which increments the revision or reapplies the mutation. Caller mutation ids reserve staging work in short SQLite transactions while archive construction and real Loader validation run outside the transaction; identical concurrent requests converge on one generation. Each building reservation binds the owner PID and exact OS process-creation identity, which first excludes process exit and PID reuse. Its exact stage Promise also holds an independent SQLite OS lock that contenders probe across Worker threads and processes. No contender steals while that Promise's Worker remains alive and holds the lease. Abnormal Worker termination releases the lease through the OS, so a later retry can replace the unfinished reservation. When stage work and reservation cleanup both fail, the ordered aggregate retains the stage failure first; retry can replace the reservation after its lease is no longer held.

State, journal, and every supported file and directory in a generation are flushed before publication. Before a writer creates or accepts `writer.sqlite`, it uses app-boot's shared `ensureDurableProfileDirectory` primitive to walk from the filesystem root to `.dsh-profile-transactions/<profile>/generations` with non-recursive directory creation. After either creating a component or observing `EEXIST` and confirming a directory, it fsyncs that component's parent before proceeding. A competing process killed between creation and its own fsync therefore cannot leave an unflushed transaction authority that another writer accepts. Any required parent-directory fsync failure aborts before coordinator admission. The coordinator accepts its current schema version only when both table definitions, complete column metadata, constraints, `STRICT` declarations, and exact primary/unique indexes match. A real process exit releases the SQLite reservation. Read-only snapshot/list project a valid durable journal without clearing it and verify every pointed immutable generation against its recorded tree digest before returning an effective path to the CLI; externally changed plugin or patch bytes therefore cannot reach Loader execution. The next writer completes a journal whose `before` state is current or accepts an already-published `after` state. Any unrelated, malformed, or incomplete relationship fails instead of guessing.

## Model Experience

### Local generation storage

#### What the model sees

Nothing. `LocalProfileTransactions` performs Host filesystem coordination and registers no model-visible content.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None; local generation files never enter a model request prefix.

## Known Limitations and Deferred Work

- Windows cannot flush directory handles through Node; file descriptors are flushed and renames remain atomic, while directory metadata persistence relies on the filesystem.
- Abort removes an uncommitted generation, but automatic retention pruning is deferred.
- P0 Provider-owned isolated Loader admission uses the product launcher's hidden child route and currently supports Web Profiles only.
- CLI validation minimizes ambient credential authority but does not confine admitted code's filesystem or network access.
