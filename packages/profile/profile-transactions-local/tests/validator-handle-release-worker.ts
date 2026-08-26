import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const VALIDATOR_ARG = '--dsh-internal-profile-validate'
const CHILD_PID_FILE = 'validator-child.pid'

if (process.argv[2] === VALIDATOR_ARG) {
  const generationPath = process.argv[4]
  if (generationPath === undefined) throw new Error('validator handle-release child requires a generation path')
  await writeFile(join(generationPath, CHILD_PID_FILE), `${String(process.pid)}\n`, { mode: 0o600 })
  setInterval(() => {}, 1_000)
} else {
  const [generationPath, installAnchor] = process.argv.slice(2)
  if (generationPath === undefined || installAnchor === undefined) {
    throw new Error('validator handle-release parent requires generationPath and installAnchor')
  }
  const { validateProfileGenerationIsolated } = await import('../src/validator.ts')
  const killDescriptor = Object.getOwnPropertyDescriptor(process, 'kill')
  if (killDescriptor === undefined) throw new Error('validator handle-release parent cannot replace process.kill')
  Object.defineProperty(process, 'kill', {
    ...killDescriptor,
    value: () => {
      throw Object.assign(new Error('injected tree kill failure'), { code: 'EPERM' })
    },
  })
  let failure: unknown
  try {
    await validateProfileGenerationIsolated('web', generationPath, installAnchor, 2_000)
  } catch (error) {
    failure = error
  } finally {
    Object.defineProperty(process, 'kill', killDescriptor)
  }
  if (!(failure instanceof AggregateError)) {
    throw new Error(`validator handle-release parent expected AggregateError, received ${String(failure)}`)
  }
  process.stdout.write(JSON.stringify(failure.errors.map((error: unknown) =>
    error instanceof Error ? error.message : String(error))))
}
