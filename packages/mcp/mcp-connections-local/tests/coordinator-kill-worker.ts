import { writeSync } from 'node:fs'
import { McpConnectionCoordinator } from '../src/coordinator.ts'

const statePath = process.argv[2]
if (statePath === undefined) throw new Error('coordinator kill worker requires a state path')

const coordinator = new McpConnectionCoordinator(statePath, 10_000)
await coordinator.run(async () => {
  writeSync(1, 'coordinator-held\n')
  process.kill(process.pid, 'SIGKILL')
  await new Promise<never>(() => {})
})
