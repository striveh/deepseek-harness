# `dsh` CLI behavior reference

English | [中文](README.zh.md)

This reference defines the profile, web-alias, plugin-management, and config-dump command modes. Argv is parsed once through [`src/args.ts`](../src/args.ts), and [`src/bin.ts`](../src/bin.ts) dynamically imports only the selected runner.

## Profile boot

`dsh --profile <name>` resolves the Profile transaction snapshot before the main Loader exists and boots its effective path: the live `$DSH_HOME/profiles/<name>` directory before the first commit, otherwise the active immutable generation. The tree is composed over an empty root by applying, in order: each bundle patch named in `dsh.profile.bundles`, the Profile's own `cordis.patch.yml`, the home-level `$DSH_HOME/cordis.patch.yml`, and each `--patch <path>` overlay in argv order. Later layers win per row; a patch replaces the targeted row's complete `config` rather than deep-merging keys, and may insert rows. A parse, schema, resolution, or plugin boot failure exits nonzero without acknowledging the generation. SIGINT and SIGTERM dispose the mounted root before exit.

Bundle names resolve from the dsh installation first, then from the effective Profile directory. In-box bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`) therefore always come from the running installation; out-of-tree bundles come from real package files in the effective tree's `node_modules`. A bare plugin `name` resolves through the effective Profile's Node parent-walk to the maintained installation fallback. For each invocation, the launcher creates `cordis.yml` under a private runtime root. A live Profile remains Loader's explicit base URL. For an active managed generation, the launcher copies the complete tree into that private root, verifies that the copied bytes and internal links reproduce the selected `ProfileTreeDigest`, confirms the same transaction snapshot again, and passes only the private copy as Loader's base URL. Replacing the authoritative generation after confirmation therefore cannot supply imported bytes; acknowledgement still fences the exact selected generation. Boot failure or root disposal removes the private root. Each private-root name records the owner PID and process-incarnation fingerprint; preparation removes exact dead-owner and PID-reuse residue but never waits for or removes a live sibling root. Relative plugin names and config paths retain Profile-relative resolution in both modes.

The `web` and `headless` Profiles auto-initialize from shipped templates on first use (`web`: base + web-app; `headless`: base + headless). Another missing Profile fails loud and asks for a complete custom Profile directory; `dsh plugin` does not create it, and the launcher supplies its private `cordis.yml` only after that directory exists.

### App arguments

The launcher's flags come first and end at the first token it does not recognize; everything from there on is handed to the booted profile verbatim through `ctx.cmdlineArgs`, where any injected app plugin may parse it ([`dsh-cmdline`](../../../packages/boot/cmdline/README.md)). `dsh --profile web --port 8080` therefore reaches the web app's `--port`, `dsh --profile web --help` prints that app's help and boots nothing, and `dsh --help` (no profile to hand it to) prints the launcher's own. `-V`/`--version` prints the launcher's version when it appears before the app-argument boundary.

A composition mounts once. An ordinary plugin injects `cmdlineArgs`, parses this app's arguments, and provides what it resolved as a service; each row configured from flags injects that service, and Loader waits for it before evaluating the row's config (`port: !!js ctx.webStartup.port ?? 3080`). A flag therefore beats the value written beside it. This precedence requires the row to retain that expression; a user patch that replaces the whole `config` with literals removes the runtime read. Help and rejected arguments request exit — nonzero for a rejection, 0 for help — without activating rows that depend on the provider's service. A live `cordis.patch.yml` edit re-evaluates expressions against services that are still up, so it cannot reset a served port.

Launcher flags must come before app arguments, and the launcher's parser consumes one `--`: an app argument that must arrive as a literal `--` needs `-- --`. A first app argument equal to `web` or `plugin` selects that subcommand instead. `ctx.cmdlineArgs.get()` is a shared immutable read: multiple plugins may parse the same snapshot, while a profile with no reader ignores its app arguments.

The shipped apps own these command lines:

| Profile | Arguments |
|---|---|
| `web` | `--host`, `--port`, repeatable `--trusted-host`, `--no-open` |
| `headless` | the task text, as the positional argument |

A one-shot task (`dsh --profile headless "run the tests"`) creates one fresh persisted Agent through the core registry, submits the task, waits for quiescence, and flushes the Session before deriving the last non-empty assistant text and final `turn/end` reason from its durable interval. It prints the text on stdout and exits 0 for `completed`, else 1. An invocation with no task is a usage error from that app. The shipped headless profile mounts no ApiProxy, Host, HTTP server, Web runtime, or browser client; a successful run writes nothing to stderr and opens no listening port.

Inspect the composed tree without booting it:

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` prints only the bundle layers; `--dump-config` adds the profile's `cordis.patch.yml`, the home-level `$DSH_HOME/cordis.patch.yml`, and `--patch` overlays. Both print comments naming the file that supplied each row and every overlay that changed it; a managed Profile comment names the authoritative generation path while the rendered bytes still come from its digest-verified private copy. `!!js` expressions remain unevaluated, and unmatched patch targets are reported on stderr. A dump never runs app command-line providers, so it shows the composed tree before any app argument is resolved and rejects an invocation that carries app arguments.

## Plugin management

`dsh plugin` accepts only exact transaction operations; arbitrary pnpm verbs and flags are rejected. Install and update require one local `.tgz`, exact package name/version, canonical caller SHA-256, and optional `--kind package|bundle` (`bundle` by default). Uninstall requires one installed package name. Configure requires an installed owner package, a file containing the typed adapter's complete normalized next `cordis.patch.yml`, and current/next SHA-256 digests. Restore publishes the verified recovery target. Every write requires `--mutation-id` matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Generate it once for one immutable intent; if completion is ambiguous, retry the exact command with the same id. A revision or tree conflict removes its unpublished stage so the same intent can retry against current fences; any other commit error retains the generation because publication may already have completed. List takes no mutation id and does not change generation or pointer state. Before reading inventory, it idempotently fills missing files from the shipped `web` or `headless` template; a missing custom Profile fails without creating its directory.

`restore-receipt --mutation-id <id>` is an automation query for one exact restore outcome. It prints one strict JSON result with `not-found` or a `committed` receipt that binds the original before/after snapshots, target generation and tree digest, and restart terminal state. The query completes a correlated durable journal after process death but never selects or publishes a new recovery target; querying a missing custom Profile does not create it.

```sh
dsh plugin --profile web install ./plugin-1.0.0.tgz --package plugin --version 1.0.0 --digest sha256:<64-hex> --mutation-id install-plugin-1.0.0
dsh plugin --profile web update ./plugin-1.1.0.tgz --package plugin --version 1.1.0 --digest sha256:<64-hex> --mutation-id update-plugin-1.1.0
dsh plugin --profile web configure plugin --patch-file ./next.cordis.patch.yml --expected-digest sha256:<64-hex> --next-digest sha256:<64-hex> --mutation-id configure-plugin-1
dsh plugin --profile web uninstall plugin --mutation-id uninstall-plugin-1
dsh plugin --profile web restore --mutation-id restore-plugin-1
dsh plugin --profile web restore-receipt --mutation-id restore-plugin-1
dsh plugin --profile web list
```

Each mutation copies a complete effective Profile, updates the exact package graph and owner-managed pnpm lock records, and runs real Web Loader activation in a bounded child. The child receives only launch, locale, and temporary-directory environment names, then uses disposable home and state directories; ambient credentials, credential-file pointers, provider endpoints, proxies, SSH-agent authority, and Node injection options are not inherited. This is not a filesystem or network sandbox: admitted plugin code still executes with the host user's operating-system authority. A successful commit prints `restart required`; it never changes the running process. The next real app boot selects the generation and acknowledges it as last-good only after Loader activation. A failed boot preserves the previous last-good. Managed generation patches are neither watched nor re-read, so configuration also crosses the restart boundary; only the home-level patch remains hot-reloadable.

P0 artifacts must be complete archives without regular/optional/bundled dependencies, installation lifecycle scripts, or `bin` entries. The real activation validator currently accepts Web Profiles only. Discovery, download, trust and approval happen before this CLI boundary.

## Web alias

`dsh web` is a hardcoded alias for `--profile web`; the flags after it belong to the web app, whose ordinary bundle provider parses them. `--host` and `--port` override the composed values of the rows that carry them, repeatable `--trusted-host` contributes invocation authorities through `ctx.webRuntime.trustedHosts` (a deployment expression concatenates its own authorities), and `--no-open` disables the default-browser handoff for this invocation. The client-plugin HMR receiver is always mounted and stays idle until a separate `pnpm run dev:web` watcher rebuilds client bundles.

```sh
dsh web
dsh web --no-open
dsh web --patch ./extra.cordis.yml
dsh web --dump-config
dsh web --help
```

The production Web runner needs built package and frontend artifacts (`pnpm run build`). It serves `http://127.0.0.1:3080` by default and, for a local launch, opens that canonical host URL only after the complete Loader tree settles. A non-empty inherited `SSH_CONNECTION` or `SSH_TTY` suppresses the browser handoff because the SSH client or editor owns the local forwarded address; the host URL is still printed. The CLI intentionally does not support `--host 0.0.0.0` yet and exits with a usage error. Immediately before a local handoff it prints `dsh web: opening the default browser; pass --no-open to disable`; if the operating-system handoff fails, a diagnostic on stderr states the reason, leaves the server running, and names the URL for manual use. `--trusted-host` adds named authorities accepted by the `/api` browser-trust fence.

Process shutdown gives the plugin tree up to five seconds to dispose. The first `SIGINT`/`SIGTERM` starts that graceful drain — `SIGTERM` is a supervisor's ordinary stop request and exits 0 on every surface, `SIGINT` reports 130; a second signal forces immediate exit. If one-shot normal completion is already stuck in disposal, the first `Ctrl+C` is the escalation and exits immediately instead of being swallowed.

All modes treat the invoking directory as the default workspace root, load applicable `AGENTS.md` or `CLAUDE.md` instructions with a 65,536-byte render budget, and use an in-memory SQLite session content index. An unmanaged live Profile watches valid edits of both `cordis.patch.yml` layers. A managed generation reuses the Profile patch parsed at boot and watches only the home layer; Profile configuration must publish another generation. A watcher setup failure while the tree remains active disposes the complete tree and private runtime root before rejecting; a registration interrupted by requested shutdown is suppressed because that shutdown already owns disposal. A one-shot surface exits through bounded shutdown, which disposes active watchers.

New sessions default to the `workspace-write` permission preset. Bash and filesystem mutations are restricted to the session workspace and platform temporary roots; reads and network access are not confined, while process visibility depends on the selected sandbox backend — bwrap runs commands in a private PID namespace that hides host processes, and Landlock and Seatbelt leave host process visibility unchanged. `DSH_PERMISSION_MODE` changes the process fallback. Stored General-settings permissions affect later Web sessions, not an already-open one.

`DSH_TOOLS_MODE` selects `native`, `code`, or `both` for the process; another value fails at boot. The shipped `minimal` agent preset keeps that deployment presentation, fixes the complete system prompt to `You are a helpful software engineer assistant.`, and composes only persistent `bash` plus `str_replace_editor`. Select 极简模式 when creating a Web session; every other prompt section and model-facing plugin remains absent from that agent while the shared browser, workspace, persistence, sandbox, and permission host stays in place.

## Shared deployment behavior

The base bundle mounts the native DeepSeek adapter, settings and credential providers, stable `web_search`, and disabled session telemetry. Provider credentials resolve from the inherited environment, `$DSH_HOME/.credentials.yaml`, the invoking directory's `.env`, then `$DSH_HOME/.env`; the managed document is never materialized into `process.env`, while both `.env` files are ordinary launch environment layers. Search uses `DEEPSEEK_API_KEY` and accepts `DEEPSEEK_SEARCH_BASE_URL`; `web_fetch` is disabled unless a patch layer inserts a provider and enables it.

Session telemetry stays local by default. `DSH_TELEMETRY_MODE=FULL` streams every projected session event as OTLP/HTTP logs, while `DSH_TELEMETRY_MODE=FEEDBACK_ONLY` uploads a session-log suffix only when feedback is recorded. `DSH_TELEMETRY_OTLP_URL` selects another collector, and any non-empty `DSH_TELEMETRY_DISABLED` remains an authoritative hard opt-out. The shipped base has no telemetry redaction rule, so explicitly enabled exports can contain message text, tool arguments and results, and workspace paths; the [default-off Agent Note](../../../.agents/notes/implemented/feature/2026-08-10-telemetry-default-off.md) owns that deployment decision.

Install an admitted external plugin bundle through the exact local `.tgz` transaction described above. Its bundle declaration contributes its patch layer after restart. The CLI also ships `@deepseek-ai/dsh-mcp-client` for patch layers, but no MCP server is enabled by default because each server command is trusted executable code outside the agent sandbox.

## Source execution

From the repository root, run `pnpm run build` separately after a fresh checkout and whenever artifacts need updating, then use `pnpm dsh <args...>`. The `package.json` script launches `apps/cli/src/bin.ts` with `node --import tsx/esm` without building and forwards every argument. Missing Typert host artifacts fail profile boot through module-resolution errors without a build instruction. Once those host artifacts exist, missing frontend or client-plugin bundles fail at startup with an instruction to run `pnpm run build`. The launcher does not check freshness, so existing stale bundles can run older browser code until rebuilt. The process inherits the launch environment; set `NODE_USE_ENV_PROXY=1` when a supporting Node version must honor `HTTP_PROXY` and `HTTPS_PROXY`. The installed form launches the built `apps/cli/lib/bin.js` without rebuilding the repository.
