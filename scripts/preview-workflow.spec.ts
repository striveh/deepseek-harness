import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview', {
    'runs-on': string
    steps: Array<{ id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }>
  }>
}
const preview = workflow.jobs.preview

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected GitHub-hosted runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview'])
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('skips deployment-owned steps when the Cloudflare credentials are absent', () => {
    // `secrets` cannot be referenced in `if:`; the workflow reads them through
    // a step-level `env` and emits an output the deployment steps consume.
    const gate = preview.steps.find(step => step.name === 'Check Cloudflare credentials')!
    expect(gate.id).toBe('cloudflare')
    expect(gate.env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    })
    expect(gate.run).toContain('"enabled=false" >> "$GITHUB_OUTPUT"')
    expect(gate.run).toContain('"enabled=true" >> "$GITHUB_OUTPUT"')
    // A half-configured integration must fail rather than report a false green.
    expect(gate.run).toContain('must both be set or both be absent')

    const deployOwned = [
      'Upload to Cloudflare Pages',
      'Verify the protected deployment serves the image',
      'Comment the preview URL',
    ]
    for (const name of deployOwned) {
      const step = preview.steps.find(s => s.name === name)!
      expect(step.if, `${name} must be gated on the credential output`).toBe(
        "${{ steps.cloudflare.outputs.enabled == 'true' }}",
      )
    }
    // The build itself stays unconditional: a keyless fork still proves the
    // preview compiles instead of turning the whole check into a gray skip.
    expect(preview.steps.find(s => s.name === 'Build workspace')?.if).toBeUndefined()
    expect(preview.steps.find(s => s.name === 'Build the preview page and pack the VFS image')?.if).toBeUndefined()
  })

  it('retains per-PR deployment, protected image verification, and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const deploy = preview.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = preview.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = preview.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
  })
})
