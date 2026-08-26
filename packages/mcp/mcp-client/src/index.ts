/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export type { McpResult } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per app, keyed off `ctx.root` (multiple apps
 * in one process — tests — must not see each other's names). A duplicate
 * namespace is a configuration error surfaced at plugin load, never silent
 * shadowing.
 */
const activeServerNames = new WeakMap<Context, Map<string, string>>()

/** Opaque live reservation for one app-root MCP server namespace. */
export interface McpServerNameReservation {
  /** Unforgeable handoff token accepted only while this reservation remains active in its app root. */
  readonly token: string
  /** Release the reservation; repeated calls are harmless. */
  release(): void
}

interface McpServerNameReservationState {
  readonly serverName: string
  readonly token: string
  readonly names: Map<string, string>
  active: boolean
}

/**
 * Atomically reserve one server namespace in the app root before a durable owner commits activation.
 * @param ctx - any Context in the target app root.
 * @param serverName - validated MCP server name.
 * @returns an opaque idempotently releasable reservation.
 */
export function reserveMcpServerName(ctx: Context, serverName: string): McpServerNameReservation {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new TypeError(`mcp-client: serverName ${JSON.stringify(serverName)} must match ${String(SERVER_NAME_PATTERN)}`)
  }
  let names = activeServerNames.get(ctx.root)
  if (names === undefined) {
    names = new Map()
    activeServerNames.set(ctx.root, names)
  }
  if (names.has(serverName)) {
    throw new Error(
      `mcp-client: serverName "${serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
    )
  }
  const token = randomUUID()
  names.set(serverName, token)
  const state: McpServerNameReservationState = { serverName, token, names, active: true }
  const reservation: McpServerNameReservation = Object.freeze({
    token,
    release() {
      if (!state.active) return
      state.active = false
      state.names.delete(state.serverName)
    },
  })
  return reservation
}

function assertMcpServerNameReservation(
  ctx: Context,
  serverName: string,
  token: string,
): void {
  if (activeServerNames.get(ctx.root)?.get(serverName) !== token) {
    throw new Error(`mcp-client: supplied serverName reservation for "${serverName}" is absent, released, or belongs to another app root`)
  }
}

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Explicit Fetch redirect policy for every MCP HTTP request. */
  redirect: 'error' | 'follow' | 'manual'
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    redirect: z.union([z.const('error'), z.const('follow'), z.const('manual')]).required(),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @param lentReservation - optional exact reservation retained by a dynamic parent lifecycle.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(
  ctx: Context,
  config: Config,
  lentReservation?: McpServerNameReservation,
): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    if (lentReservation !== undefined) {
      assertMcpServerNameReservation(ctx, config.serverName, lentReservation.token)
      return () => {}
    }
    const reservation = reserveMcpServerName(ctx, config.serverName)
    return () => { reservation.release() }
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  const connection = startConnection(ctx, config, reconnect)

  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
