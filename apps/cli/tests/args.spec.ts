import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/** Capture Commander's non-dispatch result while muting its rendered output. */
function terminalExitCode(argv: string[]): number {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    const result = parse(argv)
    if (result.mode !== 'terminal') throw new Error(`expected ${JSON.stringify(argv)} to be terminal`)
    return result.exitCode
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseDshArgs', () => {
  it('routes profile boots and the web alias, handing the rest to the app', () => {
    expect(parse(['--profile', 'tui'])).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [] })
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--patch', 'b.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml', 'b.yml'], args: [] })
    expect(parse(['web'])).toEqual({ mode: 'profile', profile: 'web', patches: [], args: [] })
    expect(parse(['web', '--patch', 'web.yml']))
      .toEqual({ mode: 'profile', profile: 'web', patches: ['web.yml'], args: [] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    // App flags, including its -h, and positionals reach the app verbatim.
    expect(parse(['--profile', 'tui', '--resume', 'abc']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: [], args: ['--resume', 'abc'] })
    expect(parse(['--profile', 'web', '-h']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['-h'] })
    expect(parse(['web', '--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag'] })
    expect(parse(['--profile', 'headless', 'run', 'the', 'tests']))
      .toEqual({ mode: 'profile', profile: 'headless', patches: [], args: ['run', 'the', 'tests'] })
    // Launcher flags placed after that boundary belong to the app too.
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--resume', 'b', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml'], args: ['--resume', 'b', '--patch', 'late.yml'] })
  })

  it('routes exact plugin lifecycle arguments to the transaction Consumer', () => {
    expect(parse(['plugin', '--profile', 'web', 'install', './p.tgz', '--package', 'p', '--version', '1.0.0', '--digest', 'sha256:x', '--mutation-id', 'install-p']))
      .toEqual({
        mode: 'plugin',
        profile: 'web',
        args: ['install', './p.tgz', '--package', 'p', '--version', '1.0.0', '--digest', 'sha256:x', '--mutation-id', 'install-p'],
      })
    expect(parse(['plugin', '--profile', 'web', 'uninstall', 'p', '--mutation-id', 'uninstall-p']))
      .toEqual({ mode: 'plugin', profile: 'web', args: ['uninstall', 'p', '--mutation-id', 'uninstall-p'] })
    expect(parse(['plugin', '--profile', 'web', 'list']))
      .toEqual({ mode: 'plugin', profile: 'web', args: ['list'] })
  })

  it('routes profile and web config dumps', () => {
    expect(parse(['--profile', 'web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['--profile', 'web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
    expect(parse(['--profile', 'tui', '--dump-config', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: false, patches: ['x.yml'] })
    expect(parse(['web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
  })

  it('rejects missing profile, removed flags, and contradictory inputs', () => {
    expect(terminalExitCode([])).toBe(1)
    expect(terminalExitCode(['tui'])).toBe(1) // an app argument without --profile has no app to reach
    expect(terminalExitCode(['--config', 'c.yml'])).toBe(1) // removed
    expect(terminalExitCode(['-p', 'task'])).toBe(1) // removed
    expect(terminalExitCode(['run', 'task'])).toBe(1) // app-owned task replaced the launcher subcommand
    expect(terminalExitCode(['--profile', ''])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', '--patch='])).toBe(1)
    expect(terminalExitCode(['--dump-config'])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', '--dump-default-config', '--patch', 'p.yml'])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', '--dump-config', 'task'])).toBe(1)
    expect(terminalExitCode(['--bogus'])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', 'web'])).toBe(1)
    expect(terminalExitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(terminalExitCode(['web', '--dump-default-config', '--patch', 'w.yml'])).toBe(1)
    expect(terminalExitCode(['web', '--patch='])).toBe(1)
    // A dump never runs app command-line providers, so it cannot show what
    // those flags would decide; printing a tree that differs from the same
    // invocation's boot would mislead.
    expect(terminalExitCode(['web', '--dump-config', '--port', '8080'])).toBe(1)
    expect(terminalExitCode(['--profile', 'web', '--dump-config', '-h'])).toBe(1)
    expect(terminalExitCode(['plugin', 'list'])).toBe(1) // --profile required
    expect(terminalExitCode(['plugin', '--profile', 'tui'])).toBe(1) // no lifecycle operation
    expect(terminalExitCode(['plugin', '--profile', ''])).toBe(1)
    expect(terminalExitCode(['--profile', 'x', 'plugin', 'add', 'y'])).toBe(1)
  })

  it('keeps its own help for an invocation with no app to hand it to', () => {
    expect(terminalExitCode(['--help'])).toBe(0)
    expect(terminalExitCode(['-h'])).toBe(0)
    expect(terminalExitCode(['--version'])).toBe(0)
  })
})
