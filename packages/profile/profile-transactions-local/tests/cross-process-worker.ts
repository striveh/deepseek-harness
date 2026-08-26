import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LocalProfileRevisionConflictError,
  LocalProfileTransactionStore,
} from '../src/runtime.ts'

const [profilesDir, artifactPath, digest, barrierDir] = process.argv.slice(2)
if (profilesDir === undefined || artifactPath === undefined || digest === undefined || barrierDir === undefined) {
  throw new Error('cross-process worker requires profilesDir, artifactPath, digest, and barrierDir')
}

const store = new LocalProfileTransactionStore({
  profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 10_000,
})
await store.initialize()
const profile = 'web'
const before = await store.snapshot(profile)
const staged = await store.stage({
  profile,
  mutationId: `process-race-${String(process.pid)}`,
  expectedRevision: before.revision,
  expectedTreeDigest: before.treeDigest,
  mutation: {
    operation: 'install',
    kind: 'bundle',
    packageName: '@example/process-race',
    version: '1.0.0',
    artifact: { path: artifactPath, digest },
  },
}, () => {})

await mkdir(barrierDir, { recursive: true })
await writeFile(join(barrierDir, `ready-${String(process.pid)}`), '')
for (;;) {
  try {
    await access(join(barrierDir, 'go'))
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

try {
  const receipt = await store.commit({
    profile,
    expectedRevision: before.revision,
    expectedTreeDigest: before.treeDigest,
    generation: staged.generation,
  })
  process.stdout.write(`${JSON.stringify({ status: 'committed', revision: receipt.after.revision })}\n`)
} catch (error) {
  if (!(error instanceof LocalProfileRevisionConflictError)) throw error
  process.stdout.write(`${JSON.stringify({ status: 'conflict', actual: error.actual })}\n`)
}
