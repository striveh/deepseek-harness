import { parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { LocalProfileTransactionStore } from '../src/runtime.ts'

interface WorkerInput {
  readonly profilesDir: string
  readonly artifactPath: string
  readonly digest: string
}

const input = workerData as WorkerInput
if (parentPort === null) throw new Error('stage owner worker requires a parent port')
const port = parentPort
const store = new LocalProfileTransactionStore({
  profilesDir: input.profilesDir,
  installAnchor: fileURLToPath(import.meta.url),
  lockWaitMs: 5_000,
})
const before = await store.snapshot('web')
const staged = await store.stage({
  profile: 'web',
  mutationId: 'worker-thread-owner',
  expectedRevision: before.revision,
  expectedTreeDigest: before.treeDigest,
  mutation: {
    operation: 'install',
    kind: 'bundle',
    packageName: '@example/process-race',
    version: '1.0.0',
    artifact: { path: input.artifactPath, digest: input.digest },
  },
}, async () => {
  port.postMessage({ kind: 'validating' })
  await new Promise<void>((resolvePromise) => {
    port.once('message', (message) => {
      if (message !== 'release') throw new Error('stage owner worker received an invalid release message')
      resolvePromise()
    })
  })
})
port.postMessage({ kind: 'complete', generation: staged.generation })
