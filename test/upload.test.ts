// Upload-surface tests: name/session sanitization, network guards, size and
// extension limits, content dedup, per-session storage, DELETE containment,
// and TTL sweeping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createUploadHandler, createSweeper, sanitizeFileName, sanitizeSessionId, sweep } from '../src/upload.ts'

test('sanitizeFileName strips control chars, separators, dot segments and leading dots', () => {
  assert.equal(sanitizeFileName('..\\..\\etc\\passwd'), 'etc_passwd')
  assert.equal(sanitizeFileName('../../.env'), 'env')
  assert.equal(sanitizeFileName('a\u0000b.txt'), 'ab.txt')
  assert.equal(sanitizeFileName('...'), 'upload.bin')
  assert.equal(sanitizeFileName('x'.repeat(200) + '.pdf').length <= 120, true)
})

test('sanitizeSessionId keeps a safe alphabet', () => {
  assert.equal(sanitizeSessionId('session-12'), 'session-12')
  assert.equal(sanitizeSessionId('../etc'), '_etc')
  assert.equal(sanitizeSessionId(''), 'anonymous')
})

async function withServer(options: Parameters<typeof createUploadHandler>[0], fn: (base: string) => Promise<void>): Promise<void> {
  const handler = createUploadHandler(options)
  const server = createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

test('upload stores files per session under the session cwd', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['session-a', sessionDir]])
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')),
      sessionCwd: (id) => sessions.get(id)
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('notes.txt'), 'x-session-id': 'session-a' },
        body: 'hello'
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as { path: string; sessionId: string }
      assert.equal(payload.sessionId, 'session-a')
      assert.ok(payload.path.startsWith(join(sessionDir, '.dsh-filess', 'session-a')))
      const files = await readdir(join(sessionDir, '.dsh-filess', 'session-a'))
      assert.equal(files.length, 1)
    }
  )
})

test('unknown session is rejected when a session resolver exists', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')),
      sessionCwd: () => undefined
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-session-id': 'ghost' },
        body: 'x'
      })
      assert.equal(res.status, 403)
    }
  )
})

test('oversized upload is rejected', async () => {
  await withServer(
    {
      maxBytes: 8,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, { method: 'POST', body: 'x'.repeat(64) })
      assert.equal(res.status, 413)
    }
  )
})

test('extension allowlist rejects disallowed types', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: ['pdf', 'txt'],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('evil.exe') },
        body: 'MZ'
      })
      assert.equal(res.status, 415)
    }
  )
})

test('identical content deduplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: dir, sessionCwd: () => dir },
    async (base) => {
      const first = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt') },
        body: 'same bytes'
      })
      const second = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt') },
        body: 'same bytes'
      })
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const a = (await first.json()) as { deduplicated?: boolean }
      const b = (await second.json()) as { deduplicated?: boolean }
      assert.equal(a.deduplicated, undefined)
      assert.equal(b.deduplicated, true)
    }
  )
})

test('DELETE refuses paths outside the session upload dir', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['s1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const outside = join(sessionDir, 'victim.txt')
      await writeFile(outside, 'secret')
      const res = await fetch(`${base}/api/upload?path=${encodeURIComponent(outside)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 's1' }
      })
      assert.equal(res.status, 403)
      const info = await stat(outside)
      assert.equal(info.isFile(), true)
    }
  )
})

test('DELETE removes an uploaded file', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['s1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const up = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('x.txt'), 'x-session-id': 's1' },
        body: 'data'
      })
      const { path } = (await up.json()) as { path: string }
      const del = await fetch(`${base}/api/upload?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 's1' }
      })
      assert.equal(del.status, 200)
      const files = await readdir(join(sessionDir, '.dsh-filess', 's1'))
      assert.equal(files.length, 0)
    }
  )
})

test('sweep removes expired files and emptied dirs, keeps fresh ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-'))
  const sessionDir = join(root, '.dsh-filess', 's1')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'old.txt'), 'x')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const result = await sweep(root, 10, () => Date.now())
  assert.equal(result.removedFiles, 1)
  assert.equal(result.removedDirs, 1)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'fresh.txt'), 'y')
  const result2 = await sweep(root, 60_000, () => Date.now())
  assert.equal(result2.removedFiles, 0)
  assert.equal(result2.removedDirs, 0)
})

test('createSweeper with zero interval does nothing and returns a disposer', () => {
  const dispose = createSweeper('/nonexistent', 1000, 0)
  assert.equal(typeof dispose, 'function')
})
