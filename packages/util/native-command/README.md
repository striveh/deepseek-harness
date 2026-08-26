# dsh-native-command

English | [中文](README.zh.md)

A host-native primitive library. `runNativeCommand(command, args, signal)` spawns an executable directly through `execFile` without a shell string, captures UTF-8 stdout/stderr, propagates abort into child termination, and hides the transient console window on Windows. Failures reject with the exit `code` and both captured streams attached, so callers classify missing tools, cancellation, and command failure without re-running anything.

The process-incarnation API distinguishes one OS process lifetime from later PID reuse. Linux reads the kernel boot id plus `/proc/<pid>/stat` start ticks; Darwin reads microsecond creation time through libproc; Windows reads 100-nanosecond creation time through `GetProcessTimes`. The Koffi dependency supplies the Darwin and Windows ABI calls without spawning a helper command. Every acquired Windows process handle must also close successfully: a `CloseHandle` failure rejects the query, and a query failure plus cleanup failure is reported as an ordered aggregate with the query failure first. An absent PID returns `null`; malformed native data, a live PID whose creation time cannot be read, and unsupported operating systems fail loud.

Command execution is consumed by [`directory-picker-native`](../../host/directory-picker-native/README.md) and [`dsh-host-apiproxy`](../../host/apiproxy/README.md). Exact process ownership is consumed by app boot and Profile transaction coordination so a stale owner cannot survive PID reuse. `NativeCommandRunner` and `ProcessIncarnationRuntime` are injectable host boundaries for those paths.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state, emits no events.

## Surface

```ts
import {
  currentProcessIncarnation,
  isProcessIncarnation,
  readProcessIncarnation,
  runNativeCommand,
  type NativeCommandRunner,
  type ProcessIncarnation,
  type ProcessIncarnationRuntime,
} from '@deepseek-ai/dsh-native-command'
```

## Model Experience

None, as this is host-side subprocess and native process inspection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No output bounding** — both streams buffer unbounded in memory; every current caller invokes small native tools whose output is a path or an error line. Adopt `dsh-output-retention` bounding before pointing this at commands with meaningful output volume.
- **Supported process inspection hosts** — exact process incarnation is implemented only for Linux, macOS, and Windows. Other platforms reject ownership inspection instead of falling back to PID-only liveness.
