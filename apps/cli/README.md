# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

The `dsh` command is the product launcher for profiles: ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `dsh --profile <name>` | Boot the named profile under `$DSH_HOME/profiles/<name>`. |
| `dsh --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `dsh web` | Alias of `--profile web`. |
| `dsh plugin --profile <name> <operation>` | Run exact install, update, uninstall, configure, restore, or read-only list through Profile transactions. |

The invoking directory is the default workspace root. The `web` and `headless` profiles auto-initialize on first use from shipped templates. Profile mutations publish a complete generation for the next process and print `restart required`. On Node 22, the launcher filters only the exact SQLite `ExperimentalWarning`; all product diagnostics and unrelated runtime warnings remain visible on stderr.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`dsh-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
dsh --profile web --port 8080       # --port belongs to the web app
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

Each invocation composes over its own launcher-owned empty root file. An unmanaged live Profile remains the relative-entry base. For an active managed generation, the launcher copies the digest-matching tree into the same invocation-private runtime root and gives only that copy to Loader; a later replacement of the authoritative generation's bytes cannot become imported plugin code. Boot failure or app disposal removes the private root and copy. Each root name binds its owner PID and exact process incarnation; later preparation removes roots whose owner exited or whose PID was reused while preserving live sibling invocations. Concurrent launches never share or write a Profile generation's `cordis.yml` path.

The tree composes in this order:
- each bundle's patch in `dsh.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`), then from the effective live tree or invocation-private managed copy's real `node_modules` package files.

`dsh plugin install` and `update` require one local `.tgz`, exact package name/version, and canonical SHA-256. `uninstall` names an installed package. `configure` transports a typed adapter's complete normalized `cordis.patch.yml` bytes with current/next digests. Every write also requires a caller-owned `--mutation-id`; reuse the exact id and command after an ambiguous completion, and never bind that id to different input. A revision or tree conflict proves that commit did not publish, so the CLI discards that unreferenced candidate and permits the same intent to stage again; any other commit failure retains the generation for exact replay. Arbitrary pnpm writes are rejected. Before the transaction owner reads its first snapshot, a first install atomically initializes or narrowly resumes the shipped Web template, then heals the installation-owned `profiles/node_modules` fallback using the same resolution authority as ordinary Profile boot. Every mutation builds a complete candidate, runs real Web Loader validation in a credential-minimized child, commits a pending-restart pointer, and becomes last-good only after the next real app boot succeeds. Validation executes admitted code with host filesystem and network authority; it is not a sandbox. Managed generation patches are not hot-reloaded; the home-level patch remains live.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.
