import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LocalProfileTransactionStore } from '../src/runtime.ts'

const [profilesDir, artifactPath, digest] = process.argv.slice(2)
if (profilesDir === undefined || artifactPath === undefined || digest === undefined) {
  throw new Error('commit state kill worker requires profilesDir, artifactPath, and digest')
}

const store = new LocalProfileTransactionStore({
  profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 10_000,
}, {
  afterStatePersisted() {
    writeSync(1, 'commit-state-durable\n')
    process.kill(process.pid, 'SIGKILL')
  },
})
await store.initialize()
const before = await store.snapshot('web')
const staged = await store.stage({
  profile: 'web',
  mutationId: 'commit-state-kill',
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
writeSync(1, `commit-generation:${staged.generation}\n`)
await store.commit({
  profile: 'web',
  expectedRevision: before.revision,
  expectedTreeDigest: before.treeDigest,
  generation: staged.generation,
})
