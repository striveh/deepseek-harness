import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LocalProfileTransactionStore } from '../src/runtime.ts'

const [profilesDir, artifactPath, digest] = process.argv.slice(2)
if (profilesDir === undefined || artifactPath === undefined || digest === undefined) {
  throw new Error('restore journal kill worker requires profilesDir, artifactPath, and digest')
}

const profile = 'web'
const prepare = new LocalProfileTransactionStore({
  profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 10_000,
})
await prepare.initialize()
let current = await prepare.snapshot(profile)
const installed = await prepare.stage({
  profile,
  mutationId: 'restore-kill-install',
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
  mutation: {
    operation: 'install',
    kind: 'bundle',
    packageName: '@example/process-race',
    version: '1.0.0',
    artifact: { path: artifactPath, digest },
  },
}, () => {})
current = (await prepare.commit({
  profile,
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
  generation: installed.generation,
})).after
current = (await prepare.acknowledgeBoot({
  profile,
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
  generation: installed.generation,
})).after
const removed = await prepare.stage({
  profile,
  mutationId: 'restore-kill-uninstall',
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
  mutation: { operation: 'uninstall', packageName: '@example/process-race' },
}, () => {})
current = (await prepare.commit({
  profile,
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
  generation: removed.generation,
})).after

const request = {
  profile,
  mutationId: 'restore-journal-kill',
  expectedRevision: current.revision,
  expectedTreeDigest: current.treeDigest,
} as const
writeSync(1, `restore-request:${JSON.stringify(request)}\n`)
const crashing = new LocalProfileTransactionStore({
  profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 10_000,
}, {
  afterJournalPersisted() {
    writeSync(1, 'restore-journal-durable\n')
    process.kill(process.pid, 'SIGKILL')
  },
})
await crashing.initialize()
await crashing.restoreLastGood(request)
