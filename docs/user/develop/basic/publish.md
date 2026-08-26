# Package and install a plugin

English | [中文](publish.zh.md)

This tutorial packages the local plugin as a complete `.tgz` bundle and manages it through the exact P0 Profile transactions. P0 accepts local artifacts only: registry discovery, download, trust, and approval happen before the `dsh plugin` command. It assumes the `dsh` CLI is installed. Complete [plugin configuration](./config.md) first.

To use a fresh source checkout, complete [run from source](../../../../README.md#run-from-source), keep this tutorial's `hello-plugin` directory at the repository root, and replace each `dsh ...` invocation below with `pnpm dsh ...`. See [source execution](../../../../apps/cli/reference/README.md#source-execution) for launcher behavior.

## Build a P0 bundle

Create the package directory:

```sh
mkdir -p hello-plugin
```

The package contains the npm manifest, one bundle patch, and the plugin module referenced by that patch:

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # bundle layer
└── index.js           # plugin module
```

Create `hello-plugin/package.json`:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

The version must be one exact SemVer such as `0.1.0`, not a range or tag. A P0 artifact cannot declare non-empty `dependencies`, `optionalDependencies`, `bundledDependencies`, or `bundleDependencies`; it also cannot declare `preinstall`, `install`, `postinstall`, or `prepare` scripts, or any `bin` entry. Ship every runtime file in the archive itself.

Create `hello-plugin/index.js`:

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

Create `hello-plugin/cordis.patch.yml`. A bundle patch refers to installed code by package name:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

The requested `--kind bundle` requires `dsh.bundle.patch` to name a regular file inside the archive. Use `--kind package` only for an artifact with no bundle declaration; such a package is installed but contributes no patch layer.

## Pack and hash the exact artifact

Pack the complete artifact, then calculate the SHA-256 of those exact `.tgz` bytes:

```sh
cd hello-plugin
pnpm pack
cd ..
ARTIFACT_SHA256="$(shasum -a 256 ./hello-plugin/dsh-hello-plugin-0.1.0.tgz | awk '{print $1}')"
```

The CLI requires the canonical digest form `sha256:<64-lowercase-hex>`. Repacking changes the bytes, so calculate the digest again after every pack.

## Install into the Web Profile

Install the bundle with the exact name, version, digest, and kind declared by the archive:

```sh
dsh plugin --profile web install \
  ./hello-plugin/dsh-hello-plugin-0.1.0.tgz \
  --package dsh-hello-plugin \
  --version 0.1.0 \
  --digest "sha256:${ARTIFACT_SHA256}" \
  --kind bundle
```

`install` requires the package to be absent. On first use, it initializes the `web` Profile, preserves its in-box bundles, records the exact package and owner-maintained lock data, and appends a validated bundle to the ordered bundle list. A successful commit prints `restart required`; it does not modify a running Web process.

Inspect the pending generation, then start a new Web process. If Web is already running, stop it before the second command:

```sh
dsh plugin --profile web list
dsh web
```

The new process boots the active immutable generation and acknowledges it as last-good only after the real Loader activation succeeds. A failed boot leaves the previous last-good generation available for recovery.

## Use the exact lifecycle operations

`dsh plugin` accepts only `install`, `update`, `uninstall`, `configure`, `restore`, and `list`. It rejects `add`, `remove`, arbitrary pnpm verbs, and unsupported or duplicate flags.

### Update

Change the package manifest to an exact next version, pack it again, and submit that artifact with `update`. The package must already be installed, and the command's name, version, digest, and kind must match the new archive exactly:

```sh
cd hello-plugin
pnpm pack
cd ..
UPDATED_ARTIFACT_SHA256="$(shasum -a 256 ./hello-plugin/dsh-hello-plugin-0.2.0.tgz | awk '{print $1}')"
dsh plugin --profile web update \
  ./hello-plugin/dsh-hello-plugin-0.2.0.tgz \
  --package dsh-hello-plugin \
  --version 0.2.0 \
  --digest "sha256:${UPDATED_ARTIFACT_SHA256}" \
  --kind bundle
```

The update becomes active only after restart.

### Configure

Configuration is an owner-mediated replacement of the Profile's complete `cordis.patch.yml`, not a fragment merge. The installed package's typed adapter must produce normalized UTF-8 text with LF line endings and a trailing newline. Read `snapshot.effectivePath` from `list`, hash the current bytes and the complete next file, then name the installed owner package:

```sh
dsh plugin --profile web list
EFFECTIVE_PROFILE=/absolute/path/from-list
EXPECTED_PATCH_SHA256="$(shasum -a 256 "${EFFECTIVE_PROFILE}/cordis.patch.yml" | awk '{print $1}')"
NEXT_PATCH_SHA256="$(shasum -a 256 ./next.cordis.patch.yml | awk '{print $1}')"
dsh plugin --profile web configure dsh-hello-plugin \
  --patch-file ./next.cordis.patch.yml \
  --expected-digest "sha256:${EXPECTED_PATCH_SHA256}" \
  --next-digest "sha256:${NEXT_PATCH_SHA256}"
```

The transaction rejects an owner package that is not installed, stale current bytes, a mismatched next digest, or a next file that is not normalized. Configure also requires restart.

### Uninstall, restore, and list

Use these operations independently:

- `dsh plugin --profile web uninstall dsh-hello-plugin` removes an installed package, its retained artifact, and its bundle-list entry in one validated generation.
- `dsh plugin --profile web restore` publishes last-good when the active generation is unverified; otherwise it publishes the verified rollback generation. It fails when no recoverable generation exists.
- `dsh plugin --profile web list` is read-only and reports the active, staged, and recoverable generations plus boot status and the effective Profile path.

Uninstall and restore print `restart required`; list never changes Profile state.

## Validation and restart behavior

Every P0 mutation follows the same rules:

- Only the `web` Profile accepts install, update, uninstall, configure, or restore mutations. `list` is read-only.
- Install requires an absent exact package name; update, uninstall, and configure require that exact package to be installed.
- The transaction owner copies the complete effective Profile, verifies artifact identity and digest, updates the package graph and lock records together, and runs Provider-owned real Web Loader activation against the unchanged candidate before commit.
- Commit publishes an immutable generation and returns `restart required`; it never hot-swaps the running process. Managed Profile configuration crosses the same restart boundary.

Validation minimizes inherited credentials and provider settings in the child process, but it is not a filesystem or network sandbox. An admitted plugin still executes with the host user's operating-system authority, so only package artifacts whose exact bytes were approved should reach this command.

## Next steps

- [Plugins and lifecycle](../framework/index.md) — the plugin programming model
- [CLI behavior reference](../../../../apps/cli/reference/README.md) — exact transaction fields, recovery, validation, and restart behavior
