import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isInsideRepo(path) {
  const rel = relative(REPO_ROOT, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function validateRealManifest(manifestInput) {
  assert(typeof manifestInput === 'string' && manifestInput !== '', 'set DSH_FILES_REAL_BENCHMARK_MANIFEST to an absolute path outside the repository')
  assert(isAbsolute(manifestInput), 'real benchmark manifest path must be absolute')
  const manifestPath = await realpath(manifestInput)
  assert(!isInsideRepo(manifestPath), 'real benchmark manifest must stay outside the repository')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert(manifest.schemaVersion === 1, 'real manifest schemaVersion must be 1')
  assert(manifest.privacy === 'local-sensitive', 'real manifest must declare privacy=local-sensitive')
  assert(Array.isArray(manifest.documents) && manifest.documents.length > 0, 'real manifest needs documents')
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'real manifest needs answer cases')
  const ids = new Set()
  for (const document of manifest.documents) {
    assert(typeof document.id === 'string' && document.id !== '', 'real document id is required')
    assert(!ids.has(document.id), `duplicate real document id: ${document.id}`)
    ids.add(document.id)
    assert(typeof document.path === 'string' && isAbsolute(document.path), `${document.id}: document path must be absolute`)
    const documentPath = await realpath(document.path)
    assert(!isInsideRepo(documentPath), `${document.id}: real document must stay outside the repository`)
    await access(documentPath)
    assert(typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(document.sha256), `${document.id}: a lowercase sha256 pin is required`)
    const actualHash = await sha256(documentPath)
    assert(actualHash === document.sha256, `${document.id}: sha256 mismatch; rebuild the gold manifest for this exact file version`)
  }
  for (const entry of manifest.cases) {
    assert(typeof entry.id === 'string' && entry.id !== '', 'real case id is required')
    assert(typeof entry.question === 'string' && entry.question !== '', `${entry.id}: question is required`)
    assert(Array.isArray(entry.expected?.facts), `${entry.id}: expected.facts must be an array`)
    assert(Array.isArray(entry.expected?.evidence), `${entry.id}: expected.evidence must be an array`)
    for (const evidence of entry.expected.evidence) {
      assert(ids.has(evidence.document), `${entry.id}: unknown evidence document ${evidence.document}`)
    }
  }
  return { manifestPath, documents: ids.size, cases: manifest.cases.length }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateRealManifest(process.env.DSH_FILES_REAL_BENCHMARK_MANIFEST)
  process.stdout.write(`${JSON.stringify({ valid: true, documents: result.documents, cases: result.cases })}\n`)
}
