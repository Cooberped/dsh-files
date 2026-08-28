// Upload-surface tests: name/session sanitization, network guards, size and
// extension limits, content dedup, per-session storage, DELETE containment,
// and TTL sweeping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createUploadHandler,
  createSweeper,
  DEFAULT_MAX_SESSION_BYTES,
  isValidSessionId,
  MAX_UPLOAD_RELATIVE_DEPTH,
  readHintFor,
  sanitizeFileName,
  sanitizeSessionId,
  sweep
} from '../src/upload.ts'
import { Config } from '../src/index.ts'

test('sanitizeFileName strips control chars, separators, dot segments and leading dots', () => {
  assert.equal(sanitizeFileName('..\\..\\etc\\passwd'), 'etc_passwd')
  assert.equal(sanitizeFileName('../../.env'), 'env')
  assert.equal(sanitizeFileName('a\u0000b.txt'), 'ab.txt')
  assert.equal(sanitizeFileName('quarter "final".xlsx'), 'quarter final.xlsx')
  assert.equal(sanitizeFileName('...'), 'upload.bin')
  assert.equal(sanitizeFileName('x'.repeat(200) + '.pdf').length <= 120, true)
})

test('sanitizeFileName keeps the byte budget when the trailing segment is not an extension', () => {
  // The extension is subtracted from the budget, so an unbounded trailing
  // segment must not be treated as one: it would leave an empty stem, emit the
  // oversized tail verbatim and make open() fail with ENAMETOOLONG (HTTP 500).
  const hostile = 'a.' + 'x'.repeat(300)
  assert.equal(Buffer.byteLength(sanitizeFileName(hostile)) <= 120, true)
  assert.equal(Buffer.byteLength(sanitizeFileName('report.' + '中'.repeat(200))) <= 120, true)
  // A real extension is still preserved, including multi-part and uppercase forms.
  assert.equal(sanitizeFileName('notes.txt'), 'notes.txt')
  assert.equal(sanitizeFileName('backup.tar.gz'), 'backup.tar.gz')
  assert.equal(sanitizeFileName('photo.JPEG'), 'photo.JPEG')
  assert.equal(sanitizeFileName('x'.repeat(200) + '.markdown').endsWith('.markdown'), true)
  // A dotted name whose tail is not extension-shaped stays intact when short.
  assert.equal(sanitizeFileName('report.final version pdf'), 'report.final version pdf')
})

test('sanitizeFileName stores Finder NFD names as NFC', () => {
  const nfc = '流程绩效-Café.pdf'
  const nfd = nfc.normalize('NFD')
  assert.notEqual(nfd, nfc)
  assert.equal(sanitizeFileName(nfd), nfc)
})

test('sanitizeSessionId keeps safe ids stable and prevents lossy collisions', () => {
  assert.equal(sanitizeSessionId('session-12'), 'session-12')
  assert.equal(sanitizeSessionId(''), 'anonymous')
  assert.notEqual(sanitizeSessionId('a/b'), sanitizeSessionId('a:b'))
  assert.match(sanitizeSessionId('../etc'), /^~etc-[0-9a-f]{32}$/)
  const hashedKey = sanitizeSessionId('a/b')
  assert.notEqual(sanitizeSessionId(hashedKey), hashedKey)
  assert.equal(isValidSessionId('session-12'), true)
  assert.equal(isValidSessionId('会话:12'), true)
  assert.equal(isValidSessionId('bad\u0000id'), false)
  assert.equal(isValidSessionId('x'.repeat(1025)), false)
})

test('session upload quota defaults to 512 MiB in the handler and plugin schema', () => {
  assert.equal(DEFAULT_MAX_SESSION_BYTES, 512 * 1024 * 1024)
  assert.equal(Config({}).maxUploadBytesPerSession, DEFAULT_MAX_SESSION_BYTES)
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
      assert.ok(payload.path.startsWith('.dsh-filess/session-a/'))
      assert.equal(payload.path.startsWith('/'), false)
      const files = await readdir(join(sessionDir, '.dsh-filess', 'session-a'))
      assert.equal(files.length, 1)
    }
  )
})

test('a hostile file name with an oversized trailing segment still persists', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['session-long', sessionDir]])
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
        headers: {
          'x-file-name': encodeURIComponent(`a.${'x'.repeat(300)}`),
          'x-session-id': 'session-long'
        },
        body: 'hello'
      })
      // Before the extension shape was bounded this reached open() with a
      // 300-byte final component and returned 500 "write failed".
      assert.equal(res.status, 200)
      const [stored] = await readdir(join(sessionDir, '.dsh-filess', 'session-long'))
      assert.equal(Buffer.byteLength(stored) <= 255, true)
    }
  )
})

test('upload preserves sub-directories from x-file-relative-path, rejecting traversal', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['session-b', sessionDir]])
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
      const safe = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('a.pdf'),
          'x-file-relative-path': encodeURIComponent('sub/dir/a.pdf'),
          'x-session-id': 'session-b'
        },
        body: 'pdf-bytes'
      })
      assert.equal(safe.status, 200)
      const subFiles = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'sub', 'dir'))
      assert.equal(subFiles.length, 1)
      assert.ok(subFiles[0].startsWith('e1af36aaec24') === false || subFiles.length === 1)
      assert.equal((await stat(join(sessionDir, '.dsh-filess', 'session-b', 'sub', 'dir', subFiles[0]))).isFile(), true)

      const traversal = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('b.pdf'),
          'x-file-relative-path': encodeURIComponent('../../etc/b.pdf'),
          'x-session-id': 'session-b'
        },
        body: 'more'
      })
      assert.equal(traversal.status, 200)
      // 逃逸段被剥离但其余路径保留：../../etc/b.pdf → etc/b.pdf，仍落在会话目录内
      const rootDirs = await readdir(join(sessionDir, '.dsh-filess', 'session-b'))
      assert.deepEqual(rootDirs.sort(), ['etc', 'sub'])
      const etcFiles = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'etc'))
      assert.equal(etcFiles.length, 1)
      assert.ok(etcFiles[0].startsWith('..') === false)
      const subFiles2 = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'sub', 'dir'))
      assert.equal(subFiles2.length, 1)
    }
  )
})

test('POST rejects a symlinked upload subdirectory instead of writing outside the session root', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-post-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-outside-'))
  const storageRoot = join(workspace, '.dsh-filess', 'symlink-post')
  await mkdir(storageRoot, { recursive: true })
  await symlink(outside, join(storageRoot, 'nested'))
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      maxSessionBytes: 0,
      defaultDir: workspace,
      sessionCwd: (id) => (id === 'symlink-post' ? workspace : undefined)
    },
    async (base) => {
      const response = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('escape.txt'),
          'x-file-relative-path': encodeURIComponent('nested/escape.txt'),
          'x-session-id': 'symlink-post'
        },
        body: 'must stay inside'
      })
      assert.equal(response.status, 403)
      assert.deepEqual(await readdir(outside), [])
    }
  )
})

test('POST rejects symlinks at the upload base and session storage root', async (t) => {
  await t.test('upload base', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-base-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-base-outside-'))
    await symlink(outside, join(workspace, '.dsh-filess'))
    await withServer(
      { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 0, defaultDir: workspace, sessionCwd: (id) => (id === 'base-link' ? workspace : undefined) },
      async (base) => {
        const response = await fetch(`${base}/api/upload`, {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent('escape.txt'), 'x-session-id': 'base-link' },
          body: 'must stay inside'
        })
        assert.equal(response.status, 403)
        assert.deepEqual(await readdir(outside), [])
      }
    )
  })

  await t.test('session root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-root-outside-'))
    await mkdir(join(workspace, '.dsh-filess'), { recursive: true })
    await symlink(outside, join(workspace, '.dsh-filess', 'root-link'))
    await withServer(
      { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 0, defaultDir: workspace, sessionCwd: (id) => (id === 'root-link' ? workspace : undefined) },
      async (base) => {
        const response = await fetch(`${base}/api/upload`, {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent('escape.txt'), 'x-session-id': 'root-link' },
          body: 'must stay inside'
        })
        assert.equal(response.status, 403)
        assert.deepEqual(await readdir(outside), [])
      }
    )
  })
})

test('POST rejects a digest-shaped final symlink instead of treating it as deduplicated content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-final-'))
  const outside = join(await mkdtemp(join(tmpdir(), 'dsh-files-symlink-final-outside-')), 'secret.txt')
  const storageRoot = join(workspace, '.dsh-filess', 'final-link')
  const body = 'same digest bytes'
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  await mkdir(storageRoot, { recursive: true })
  await writeFile(outside, 'outside secret')
  await symlink(outside, join(storageRoot, `${digest}-escape.txt`))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 0, defaultDir: workspace, sessionCwd: (id) => (id === 'final-link' ? workspace : undefined) },
    async (base) => {
      const response = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('escape.txt'), 'x-session-id': 'final-link' },
        body
      })
      assert.equal(response.status, 403)
      assert.equal(await readFile(outside, 'utf8'), 'outside secret')
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

test('raw session ids are resolved exactly and collision-prone ids use separate storage keys', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-collision-'))
  const sessions = new Map([
    ['a/b', sessionDir],
    ['a:b', sessionDir]
  ])
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
      const upload = async (sessionId: string, body: string) => {
        const res = await fetch(`${base}/api/upload`, {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent('notes.txt'), 'x-session-id': sessionId },
          body
        })
        assert.equal(res.status, 200)
        return (await res.json()) as { path: string; sessionId: string }
      }
      const slash = await upload('a/b', 'slash')
      const colon = await upload('a:b', 'colon')
      assert.equal(slash.sessionId, 'a/b')
      assert.equal(colon.sessionId, 'a:b')
      assert.notEqual(slash.path.split('/')[1], colon.path.split('/')[1])
      assert.ok(slash.path.includes(sanitizeSessionId('a/b')))
      assert.ok(colon.path.includes(sanitizeSessionId('a:b')))
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

test('extension allowlist treats extensionless names as bin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-extensionless-'))
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: ['bin'],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: dir
    },
    async (base) => {
      const accepted = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('README') },
        body: 'plain text'
      })
      assert.equal(accepted.status, 200)
    }
  )
})

test('extension allowlist rejects metadata before persisting the body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-allowlist-'))
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: ['pdf'],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: dir
    },
    async (base) => {
      const rejected = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('payload.exe') },
        body: 'MZ'.repeat(4096)
      })
      assert.equal(rejected.status, 415)
      await assert.rejects(readdir(join(dir, '.dsh-filess', 'anonymous')))
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

test('stored file names use a 64-bit content digest prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-digest-'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: dir },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('evidence.txt') },
        body: 'digest evidence'
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as { path: string }
      assert.match(payload.path.split('/').at(-1) ?? '', /^[0-9a-f]{16}-evidence\.txt$/)
    }
  )
})

test('identical content with different names stores one file and returns the existing path', async () => {
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
        headers: { 'x-file-name': encodeURIComponent('b.txt') },
        body: 'same bytes'
      })
      const a = (await first.json()) as { path: string; deduplicated?: boolean }
      const b = (await second.json()) as { path: string; deduplicated?: boolean }
      assert.equal(b.deduplicated, true)
      // 第二次返回已存在文件的路径，模型读取不会 404。
      assert.equal(a.path, b.path)
      const files = await readdir(join(dir, '.dsh-filess', 'anonymous'))
      assert.equal(files.length, 1)
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
        headers: { 'x-file-name': encodeURIComponent('100%20 plan.txt'), 'x-session-id': 's1' },
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

test('DELETE cannot cross session upload directories even when sessions share one cwd', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-shared-workspace-'))
  const sessions = new Map([
    ['s1', workspace],
    ['s2', workspace]
  ])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: workspace, sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const up = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('private.txt'), 'x-session-id': 's1' },
        body: 'private'
      })
      assert.equal(up.status, 200)
      const { path } = (await up.json()) as { path: string }
      const denied = await fetch(`${base}/api/upload?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 's2' }
      })
      assert.equal(denied.status, 403)
      assert.equal((await stat(join(workspace, path))).isFile(), true)
    }
  )
})

test('DELETE rejects an intermediate symlink and preserves the outside file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-delete-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-delete-outside-'))
  const storageRoot = join(workspace, '.dsh-filess', 'symlink-delete')
  await mkdir(storageRoot, { recursive: true })
  await writeFile(join(outside, 'victim.txt'), 'outside secret')
  await symlink(outside, join(storageRoot, 'nested'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: workspace, sessionCwd: (id) => (id === 'symlink-delete' ? workspace : undefined) },
    async (base) => {
      const projected = '.dsh-filess/symlink-delete/nested/victim.txt'
      const response = await fetch(`${base}/api/upload?path=${encodeURIComponent(projected)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 'symlink-delete' }
      })
      assert.equal(response.status, 403)
      assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'outside secret')
    }
  )
})

test('folder upload rejects paths deeper than the bounded directory limit', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-depth-'))
  const sessions = new Map([['depth', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: sessionDir, sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const rel = (depth: number) => [...Array.from({ length: depth }, (_, i) => `d${i}`), 'file.txt'].join('/')
      const accepted = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('file.txt'),
          'x-file-relative-path': encodeURIComponent(rel(MAX_UPLOAD_RELATIVE_DEPTH)),
          'x-session-id': 'depth'
        },
        body: 'within limit'
      })
      assert.equal(accepted.status, 200)
      const rejected = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('file.txt'),
          'x-file-relative-path': encodeURIComponent(rel(MAX_UPLOAD_RELATIVE_DEPTH + 1)),
          'x-session-id': 'depth'
        },
        body: 'too deep'
      })
      assert.equal(rejected.status, 400)
      assert.match(((await rejected.json()) as { error: string }).error, /exceeds 16 directories/)
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

test('sweep recursively removes expired folder uploads without following sibling paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-tree-'))
  const nested = join(root, '.dsh-filess', 's1', 'reports', '2026')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'old.xlsx'), 'x')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const result = await sweep(root, 10, () => Date.now())
  assert.equal(result.removedFiles, 1)
  assert.ok(result.removedDirs >= 3)
  await assert.rejects(stat(join(root, '.dsh-filess', 's1')))
})

test('sweep fails closed when the upload base itself is a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-link-outside-'))
  const victim = join(outside, 'victim.txt')
  await writeFile(victim, 'outside secret')
  await symlink(outside, join(root, '.dsh-filess'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await assert.rejects(sweep(root, 10, () => Date.now()), /unsafe upload path/)
  assert.equal(await readFile(victim, 'utf8'), 'outside secret')
})

test('createSweeper with zero interval does nothing and returns a disposer', () => {
  const dispose = createSweeper('/nonexistent', 1000, 0)
  assert.equal(typeof dispose, 'function')
})

test('sanitizeFileName truncates by UTF-8 bytes, not characters', () => {
  // 250 个中文字符 = 750 字节；按字符截断会超 255 字节文件系统上限。
  const name = sanitizeFileName('中文文件名'.repeat(50))
  assert.ok(Buffer.byteLength(name) <= 120, `bytes ${Buffer.byteLength(name)} > 120`)
  assert.equal(name.length, 40) // 120 字节 / 每字 3 字节
  assert.ok(name.endsWith('名')) // 不切半个字符
  // ASCII 长名保持原有截断行为
  assert.equal(sanitizeFileName('x'.repeat(200) + '.pdf').length, 120)
})

test('sanitizeFileName preserves the extension when truncating a long stem', () => {
  // 长主干 + 扩展名：截断不能把 .pdf/.xlsx 切掉，否则 allowlist 与
  // 客户端徽章会把文件当成无扩展名。
  const name = sanitizeFileName('y'.repeat(300) + '.xlsx')
  assert.ok(name.endsWith('.xlsx'), `expected .xlsx suffix, got "${name}"`)
  assert.ok(Buffer.byteLength(name) <= 120)
  // 中文长名 + 扩展名同样保留扩展名。
  const cn = sanitizeFileName('中文文件名'.repeat(50) + '.pdf')
  assert.ok(cn.endsWith('.pdf'), `expected .pdf suffix, got "${cn}"`)
  assert.ok(Buffer.byteLength(cn) <= 120)
})

test('sanitizeFileName rejects pure dot names', () => {
  assert.equal(sanitizeFileName('...'), 'upload.bin')
  assert.equal(sanitizeFileName('..'), 'upload.bin')
})

test('upload response carries the byte-sniffed format', async () => {
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')) },
    async (base) => {
      // 扩展名撒谎：.txt 的真实内容是 PDF，嗅探必须胜出。
      const pdf = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('notes.txt') },
        body: '%PDF-1.7 fake'
      })
      assert.equal(pdf.status, 200)
      const p = (await pdf.json()) as { sniffedFormat: string | null }
      assert.equal(p.sniffedFormat, 'pdf')
      // exe 伪装成 .pdf：嗅探为 null（已知二进制），客户端不会按扩展名着色。
      const exe = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('photo.pdf') },
        body: 'MZ\x90\x00\x03\x00\x00\x00\x04\x00'
      })
      assert.equal(exe.status, 200)
      const e = (await exe.json()) as { sniffedFormat: string | null }
      assert.equal(e.sniffedFormat, null)
      // 普通文本
      const txt = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('x.bin') },
        body: 'hello world'
      })
      const t = (await txt.json()) as { sniffedFormat: string | null }
      assert.equal(t.sniffedFormat, 'text')
    }
  )
})

test('session quota rejects oversize totals with 507', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['q1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 16, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const ok = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt'), 'x-session-id': 'q1' },
        body: '0123456789abcdef'
      })
      assert.equal(ok.status, 200)
      // 16 字节已满，再传 1 字节必须 507，且不落盘。
      const over = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('b.txt'), 'x-session-id': 'q1' },
        body: 'x'
      })
      assert.equal(over.status, 507)
      const files = await readdir(join(sessionDir, '.dsh-filess', 'q1'))
      assert.equal(files.length, 1)
    }
  )
})

test('session quota fails closed when the upload tree contains a symlink', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-quota-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-files-symlink-quota-outside-'))
  const storageRoot = join(workspace, '.dsh-filess', 'symlink-quota')
  await mkdir(storageRoot, { recursive: true })
  await writeFile(join(outside, 'hidden.txt'), 'not counted by the vulnerable scan')
  await symlink(outside, join(storageRoot, 'linked'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 1024, defaultDir: workspace, sessionCwd: (id) => (id === 'symlink-quota' ? workspace : undefined) },
    async (base) => {
      const response = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('new.txt'), 'x-session-id': 'symlink-quota' },
        body: 'new data'
      })
      assert.equal(response.status, 403)
      assert.deepEqual(await readdir(storageRoot), ['linked'])
    }
  )
})

test('session quota serializes concurrent uploads so the total cannot overshoot', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-quota-race-'))
  const sessions = new Map([['q-race', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 16, defaultDir: sessionDir, sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const send = (name: string, body: string) => fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent(name), 'x-session-id': 'q-race' },
        body
      })
      const responses = await Promise.all([
        send('a.txt', 'a'.repeat(10)),
        send('b.txt', 'b'.repeat(10)),
        send('c.txt', 'c'.repeat(10)),
        send('d.txt', 'd'.repeat(10))
      ])
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 507, 507, 507])
      const files = await readdir(join(sessionDir, '.dsh-filess', 'q-race'))
      assert.equal(files.length, 1)
    }
  )
})

test('session quota recursively counts folder uploads as file bytes', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-tree-'))
  const sessions = new Map([['q-tree', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 1000, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const nested = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('nested.txt'),
          'x-file-relative-path': encodeURIComponent('folder/nested.txt'),
          'x-session-id': 'q-tree'
        },
        body: 'n'.repeat(600)
      })
      assert.equal(nested.status, 200)

      // 目录自身的 stat.size 不应造成误拒：真实内容合计 900 字节。
      const within = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('within.txt'), 'x-session-id': 'q-tree' },
        body: 'w'.repeat(300)
      })
      assert.equal(within.status, 200)

      // 递归计入嵌套的 600 字节后，再传 101 字节会精确越过 1000。
      const over = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('over.txt'), 'x-session-id': 'q-tree' },
        body: 'x'.repeat(101)
      })
      assert.equal(over.status, 507)
    }
  )
})

test('readHintFor labels the read cost by size and format', () => {
  assert.equal(readHintFor('text', 5000).cost, 'cheap')
  assert.equal(readHintFor('text', 2 * 1024 * 1024).cost, 'moderate')
  assert.equal(readHintFor('pdf', 20 * 1024 * 1024).cost, 'expensive')
  // text 给字符估算、且不超过单次窗口上限；其它格式给保守默认。
  const t = readHintFor('text', 10000)
  assert.ok(t.estimatedChars >= 2000 && t.estimatedChars <= 24000)
  assert.equal(readHintFor('pdf', 12345).estimatedChars, 12000)
})
