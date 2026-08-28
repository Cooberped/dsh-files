// Workspace index tests: ignore lists, depth/count caps, symlink skipping,
// relative-path output, and the HTTP handler contract (GET only, network
// guard, unknown session rejection).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWorkspaceFilesHandler, indexWorkspace } from '../src/workspace.ts'

async function withTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-test-'))
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

test('indexWorkspace returns relative POSIX paths, skipping ignored dirs and files', async () => {
  const root = await withTree({
    'src/index.ts': 'a',
    'src/util/helper.ts': 'b',
    'src/vendor/third.ts': 'c',
    'node_modules/pkg/index.js': 'd',
    'docs/spec.md': 'e',
    'README.md': 'f',
    '.git/config': 'g',
    '.DS_Store': 'h',
    'data/out.log': 'i',
    'data/keep.db': 'j'
  })
  const files = await indexWorkspace(root)
  assert.deepEqual(files.sort(), ['README.md', 'data/keep.db', 'docs/spec.md', 'src/index.ts', 'src/util/helper.ts'])
})

test('indexWorkspace honors custom ignoredDirs option', async () => {
  const root = await withTree({
    'src/index.ts': 'a',
    'src/util/helper.ts': 'b',
    'private/secret.ts': 'c'
  })
  const files = await indexWorkspace(root, { ignoredDirs: new Set(['private']) })
  assert.deepEqual(files.sort(), ['src/index.ts', 'src/util/helper.ts'])
})

test('indexWorkspace skips symlinks entirely', async () => {
  const root = await withTree({ 'real/file.ts': 'x', 'real/keep.ts': 'y' })
  await symlink(join(root, 'real'), join(root, 'link'), 'dir')
  const files = await indexWorkspace(root)
  assert.deepEqual(files.sort(), ['real/file.ts', 'real/keep.ts'])
})

test('indexWorkspace honors maxFiles and maxDepth caps', async () => {
  const root = await withTree({
    'a/b/c/deep.ts': '1',
    'a/b/mid.ts': '2',
    'a/top.ts': '3'
  })
  const capped = await indexWorkspace(root, { maxDepth: 1 })
  assert.deepEqual(capped, ['a/top.ts'])
  const counted = await indexWorkspace(root, { maxFiles: 2 })
  assert.equal(counted.length, 2)
})

test('workspace files handler returns 405 for non-GET and 403 for unknown session', async () => {
  const handler = createWorkspaceFilesHandler({
    sessionCwd: async (id) => (id === 'known' ? '/tmp' : undefined)
  })
  const server = createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const denied = await fetch(`${base}/api/workspace-files?session=ghost`, {
      headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' }
    })
    assert.equal(denied.status, 403)
    const method = await fetch(`${base}/api/workspace-files?session=known`, { method: 'POST' })
    assert.equal(method.status, 405)
  } finally {
    server.close()
  }
})

test('workspace handler resolves raw session ids exactly instead of lossy normalization', async () => {
  const root = await withTree({ 'secret.txt': 'secret' })
  const seen: string[] = []
  const handler = createWorkspaceFilesHandler({
    sessionCwd: async (id) => {
      seen.push(id)
      return id === 'a_b' ? root : undefined
    }
  })
  const server = createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const collision = await fetch(`${base}/api/workspace-files?session=${encodeURIComponent('a:b')}`, {
      headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' }
    })
    assert.equal(collision.status, 403)
    assert.deepEqual(seen, ['a:b'])

    const invalid = await fetch(`${base}/api/workspace-files?session=${encodeURIComponent('bad\u0000id')}`, {
      headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' }
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(seen, ['a:b'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
})
