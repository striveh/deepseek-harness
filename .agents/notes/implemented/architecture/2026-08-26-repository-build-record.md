# Agent Note: Bind complete builds to repository source and runtime artifacts

Status: implemented

English | [中文](2026-08-26-repository-build-record.zh.md)

## Problem

Local integration acceptance runs built `lib` files, while ordinary source tests resolve workspace imports to `src`. A checkout can therefore contain current source beside runtime output from an earlier build. Checking that an output exists or reports the package version does not prove that the executed bytes were produced from the current checkout because package versions remain unchanged across many source revisions.

The Extension Center local-HEAD acceptance must distinguish current-source evidence from a run against stale Host output. Modification times are insufficient because copied files, restored caches, and clock differences can make unrelated source and output appear fresh.

## Decision

Every successful root `pnpm run build` writes format-v2 `.dsh-build/repository-build.json`. The record contains a deterministic content digest and a filesystem-identity digest over every Git-tracked and non-ignored source entry, plus a content digest over Host-side application, package, and vendored `lib` files. Each digest records the exact file count. The separate client-build record continues to own `apps/web/dist`, dynamic Client bundles, and public browser environment values.

The source content digest frames the repository-relative path, regular-file, symbolic-link, or tracked-missing kind, executable mode, and bytes. The identity digest frames the same path and kind plus device, inode, size, nanosecond modification time, nanosecond change time, full mode, and raw symbolic-link target; access time is deliberately excluded. A source symlink must resolve inside the canonical checkout, and every file reachable through a linked directory must itself be in the recorded source set. The Host-side `lib` scan includes dotfiles, preserves literal path characters such as POSIX backslashes, excludes TypeScript build-info files, and rejects symbolic-link or non-regular artifacts.

The build wrapper observes the source immediately before build orchestration and again after the library and Web build steps. Different content or identity observations reject the build and leave no new record. A successful observation is written through a process- and UUID-specific temporary file followed by an atomic rename; partial build commands do not update it.

A consumer that claims current-checkout evidence independently recomputes the source and Host-side `lib` digests and requires exact equality before executing a built entrypoint. A long-running acceptance lane also repeats verification at its endpoint and requires the record bytes to retain the same SHA-256 digest. The record is gitignored local-checkout evidence, not a published compatibility promise and not a substitute for packed-artifact, Client/browser, or released-Host acceptance.

These are endpoint observations. The identity digest detects ordinary in-place rewrites and same-content atomic replacements, but it does not prove that no transient edit was restored with indistinguishable content and metadata, that a compiler consumed the observed bytes, or that outputs came from an immutable source snapshot. Claims requiring causal build provenance need an isolated immutable-source build and artifact publication design.

## Alternatives considered

**Compare modification times.** File timestamps do not bind content and can move backward or survive copied caches.

**Compare only `git rev-parse HEAD`.** A dirty tracked file or non-ignored untracked build input can differ from HEAD while the reported commit remains unchanged.

**Run the built CLI and compare its version.** The source and stale output usually carry the same pre-release package version.

**Make each consumer rebuild the Host checkout.** An acceptance tool should not mutate a caller-selected checkout, and rebuilding does not provide a durable receipt that later output remained unchanged.

**Run the complete build from an immutable source snapshot.** This would support a stronger causal claim, but the current root build spans pnpm workspace links, TypeScript Project References, tsdown, and Vite outputs in the caller's checkout. Snapshot construction and artifact publication therefore require a separate repository-wide design rather than a P0 verifier change.

## Consequences

Current-checkout integration evidence now fails closed when the record is missing, either source endpoint differs, source changes after the record, a Host-side `lib` file changes, or only a partial build runs. A complete build costs one additional repository source scan and one runtime artifact scan. Any non-ignored source change, including documentation, requires another complete build; this favors a complete local observation over a smaller dependency approximation.

The repository build record answers whether the current source observation and current Host-side `lib` artifacts equal those recorded by the complete build wrapper. It does not claim immutable or causal source-to-output provenance, and it does not replace the client-build record for browser artifacts.
