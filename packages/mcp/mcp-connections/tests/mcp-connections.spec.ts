import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  isMcpConnectionDigest,
  mcpConnectionId,
  mcpConnectionMutationId,
  parseMcpConnectionDesired,
  parseMcpTransportDescriptor,
} from '../src/index.ts'

const reconnect = {
  enabled: true,
  initialDelayMs: 10,
  maxDelayMs: 100,
  maxAttempts: 3,
} as const

describe('managed MCP identifiers', () => {
  it('brands only names accepted by the public MCP tool namespace', () => {
    expect(mcpConnectionId('github-prod_1')).toBe('github-prod_1')
    expect(() => mcpConnectionId('bad name')).toThrow(/must match/)
    expect(() => mcpConnectionId('x'.repeat(33))).toThrow(/must match/)
  })

  it('brands bounded durable mutation ids', () => {
    expect(mcpConnectionMutationId('install:github:0001')).toBe('install:github:0001')
    expect(() => mcpConnectionMutationId('has space')).toThrow(/must match/)
  })

  it('recognizes only canonical lowercase SHA-256 digests', () => {
    expect(isMcpConnectionDigest('a'.repeat(64))).toBe(true)
    expect(isMcpConnectionDigest('A'.repeat(64))).toBe(false)
    expect(isMcpConnectionDigest('a'.repeat(63))).toBe(false)
  })
})

describe('durable descriptor parser', () => {
  it('detaches and freezes an exact stdio desired record', () => {
    const input = {
      id: 'filesystem',
      enabled: false,
      transport: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { MODE: 'readonly' },
        cwd: '',
        toolCallTimeoutMs: 30_000,
        reconnect,
      },
    }
    const desired = parseMcpConnectionDesired(input)
    input.transport.args[0] = 'changed.js'
    expect(desired.transport).toMatchObject({ transport: 'stdio', args: ['server.js'] })
    expect(Object.isFrozen(desired)).toBe(true)
    expect(Object.isFrozen(desired.transport)).toBe(true)
  })

  it('accepts HTTP and rejects unknown keys, unsafe protocols, and incomplete policies', () => {
    expect(parseMcpTransportDescriptor({
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
      headers: {},
      redirect: 'error',
      toolCallTimeoutMs: 10_000,
      reconnect,
    })).toMatchObject({ transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', redirect: 'error' })

    expect(() => parseMcpTransportDescriptor({
      transport: 'streamable-http',
      url: 'file:///tmp/mcp',
      headers: {},
      redirect: 'error',
      toolCallTimeoutMs: 10_000,
      reconnect,
    })).toThrow(/HTTP or HTTPS/)
    expect(() => parseMcpTransportDescriptor({
      transport: 'streamable-http',
      url: 'https://mcp.example.test/',
      headers: {},
      toolCallTimeoutMs: 10_000,
      reconnect,
    })).toThrow(/redirect is required/)
    expect(() => parseMcpTransportDescriptor({
      transport: 'streamable-http',
      url: 'https://mcp.example.test/',
      headers: {},
      redirect: 'same-origin',
      toolCallTimeoutMs: 10_000,
      reconnect,
    })).toThrow(/must be "error", "follow", or "manual"/)
    expect(() => parseMcpTransportDescriptor({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect,
      secretExtra: true,
    })).toThrow(/secretExtra is not supported/)
    expect(() => parseMcpTransportDescriptor({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect: { enabled: true },
    })).toThrow(/initialDelayMs is required/)
  })

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [new Date(), /must be an object/],
    [{}, /transport must be "stdio" or "streamable-http"/],
    [{ transport: 'websocket' }, /transport must be "stdio" or "streamable-http"/],
  ])('rejects a non-descriptor transport %#', (value, message) => {
    expect(() => parseMcpTransportDescriptor(value)).toThrow(message)
  })

  it.each([
    [{ enabled: false, transport: {} }, /\.id is required/],
    [{ id: 1, enabled: false, transport: {} }, /\.id must be a string/],
    [{ id: 'server', enabled: 'yes', transport: {} }, /\.enabled must be a boolean/],
    [{ id: 'server', enabled: false, transport: {}, extra: true }, /\.extra is not supported/],
  ])('rejects an invalid desired record %#', (value, message) => {
    expect(() => parseMcpConnectionDesired(value)).toThrow(message)
  })

  it.each([
    ['command type', { command: 1 }, /command must be a string/],
    ['blank command', { command: ' ' }, /command must be non-blank/],
    ['trimmed command', { command: ' node' }, /command must be non-blank/],
    ['command NUL', { command: 'node\0' }, /command must not contain NUL/],
    ['cwd type', { cwd: 1 }, /cwd must be a string/],
    ['cwd NUL', { cwd: '/tmp\0' }, /cwd must not contain NUL/],
    ['args type', { args: {} }, /args must be an array/],
    ['arg type', { args: [1] }, /args\[0\] must be a string/],
    ['arg NUL', { args: ['bad\0'] }, /args\[0\] must not contain NUL/],
    ['env type', { env: [] }, /env must be a string map/],
    ['empty env key', { env: { '': 'value' } }, /keys must be non-empty/],
    ['env key NUL', { env: { 'BAD\0': 'value' } }, /key must not contain NUL/],
    ['env value type', { env: { MODE: 1 } }, /MODE must be a string/],
    ['env value NUL', { env: { MODE: 'bad\0' } }, /MODE must not contain NUL/],
    ['timeout zero', { toolCallTimeoutMs: 0 }, /positive safe integer/],
    ['timeout fractional', { toolCallTimeoutMs: 1.5 }, /positive safe integer/],
    ['timeout timer overflow', { toolCallTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, /toolCallTimeoutMs must not exceed 2147483647/],
    ['reconnect type', { reconnect: null }, /reconnect must be an object/],
    ['reconnect enabled', { reconnect: { ...reconnect, enabled: 'yes' } }, /enabled must be a boolean/],
    ['reconnect initial zero', { reconnect: { ...reconnect, initialDelayMs: 0 } }, /initialDelayMs must be a positive/],
    ['reconnect max zero', { reconnect: { ...reconnect, maxDelayMs: 0 } }, /maxDelayMs must be a positive/],
    ['reconnect initial timer overflow', { reconnect: { ...reconnect, initialDelayMs: MAX_TIMER_DELAY_MS + 1, maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /initialDelayMs must not exceed 2147483647/],
    ['reconnect max timer overflow', { reconnect: { ...reconnect, maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /maxDelayMs must not exceed 2147483647/],
    ['reconnect inverted', { reconnect: { ...reconnect, initialDelayMs: 101 } }, /must not exceed/],
    ['reconnect attempts zero', { reconnect: { ...reconnect, maxAttempts: 0 } }, /maxAttempts must be a positive/],
  ])('rejects invalid stdio %s', (_name, patch, message) => {
    expect(() => parseMcpTransportDescriptor({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect,
      ...patch,
    })).toThrow(message)
  })

  it.each([
    ['URL type', { url: 1 }, /url must be a string/],
    ['invalid URL', { url: 'not a URL' }, /absolute HTTP or HTTPS URL/],
    ['headers type', { headers: [] }, /headers must be a string map/],
    ['header value NUL', { headers: { Authorization: 'bad\0' } }, /Authorization must not contain NUL/],
    ['redirect', { redirect: 'redirect' }, /must be "error", "follow", or "manual"/],
    ['timeout timer overflow', { toolCallTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, /toolCallTimeoutMs must not exceed 2147483647/],
  ])('rejects invalid HTTP %s', (_name, patch, message) => {
    expect(() => parseMcpTransportDescriptor({
      transport: 'streamable-http',
      url: 'https://mcp.example.test/',
      headers: {},
      redirect: 'error',
      toolCallTimeoutMs: 10_000,
      reconnect,
      ...patch,
    })).toThrow(message)
  })
})
