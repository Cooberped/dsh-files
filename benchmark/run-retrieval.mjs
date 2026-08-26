import { performance } from 'node:perf_hooks'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { buildDocumentBlocks } from '../src/retrieval/blocks.ts'
import { MemoryRetrievalBackend, SqliteRetrievalBackend, searchBackend } from '../src/retrieval/backend.ts'
import { DEFAULT_FIXTURE_DIR } from './generate-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const casesPath = join(HERE, 'retrieval.synthetic.json')
const documents = [
  { id: 'kickoff-pdf', file: 'atlas-kickoff.pdf', format: 'pdf' },
  { id: 'meeting-docx', file: '流程绩效-Café会议纪要.docx', format: 'docx' },
  { id: 'metrics-xlsx', file: 'atlas-metrics.xlsx', format: 'xlsx' }
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeBackend(kind) {
  if (kind === 'js-memory') return new MemoryRetrievalBackend()
  if (kind === 'sqlite-fts5') return new SqliteRetrievalBackend(new DatabaseSync(':memory:'))
  throw new Error(`unsupported benchmark backend: ${kind}`)
}

async function loadBlocks() {
  const output = []
  const startedAt = performance.now()
  for (const document of documents) {
    const bytes = new Uint8Array(await readFile(join(DEFAULT_FIXTURE_DIR, document.file)))
    const descriptor = {
      id: document.id,
      path: `/synthetic/${document.file}`,
      format: document.format,
      version: `synthetic-${document.id}-v1`
    }
    const blocks = await buildDocumentBlocks(bytes, descriptor, { blockChars: 1600, maxBlocks: 20_000 })
    output.push({ descriptor, blocks })
  }
  return { documents: output, parseMs: performance.now() - startedAt }
}

function validateHitExpectation(entry, hits) {
  return hits.some((hit) => {
    if (hit.documentId !== entry.document) return false
    if (entry.coordinate !== undefined && hit.coordinate !== entry.coordinate) return false
    if (entry.coordinatePrefix !== undefined && !hit.coordinate.startsWith(entry.coordinatePrefix)) return false
    const evidence = `${hit.heading}\n${hit.coordinate}\n${hit.text}`
    return entry.facts.every((fact) => evidence.includes(fact))
  })
}

export async function runSyntheticRetrievalBenchmark(kind) {
  const manifest = JSON.parse(await readFile(casesPath, 'utf8'))
  assert(manifest.schemaVersion === 1, 'retrieval benchmark schemaVersion must be 1')
  assert(manifest.privacy === 'synthetic-only', 'retrieval benchmark must be synthetic-only')
  assert(Array.isArray(manifest.cases) && manifest.cases.length === 10, 'retrieval benchmark must contain ten cases')
  const loaded = await loadBlocks()
  const backend = makeBackend(kind)
  try {
    const indexedAt = performance.now()
    for (const document of loaded.documents) {
      backend.replaceDocument(document.descriptor, document.blocks, Date.now())
    }
    const indexMs = performance.now() - indexedAt
    const documentIds = loaded.documents.map((document) => document.descriptor.id)
    const results = []
    for (const entry of manifest.cases) {
      const queryAt = performance.now()
      const hits = searchBackend(backend, entry.query, documentIds, 12)
      const queryMs = performance.now() - queryAt
      const missing = entry.mustFind.filter((expectation) => !validateHitExpectation(expectation, hits))
      const combined = hits.map((hit) => `${hit.heading}\n${hit.coordinate}\n${hit.text}`).join('\n')
      const forbidden = (entry.mustNotContain ?? []).filter((fact) => combined.includes(fact))
      results.push({ id: entry.id, passed: missing.length === 0 && forbidden.length === 0, hits: hits.length, queryMs, missing, forbidden })
    }
    const passed = results.filter((result) => result.passed).length
    return {
      backend: kind,
      cases: results.length,
      passed,
      recall: passed / results.length,
      parseMs: loaded.parseMs,
      indexMs,
      queryMs: results.reduce((sum, result) => sum + result.queryMs, 0),
      failures: results.filter((result) => !result.passed)
    }
  } finally {
    backend.close()
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.find((arg) => arg.startsWith('--backend='))?.slice('--backend='.length)
  const kinds = requested === undefined ? ['sqlite-fts5', 'js-memory'] : [requested]
  const reports = []
  for (const kind of kinds) reports.push(await runSyntheticRetrievalBenchmark(kind))
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
  if (reports.some((report) => report.recall !== 1)) process.exitCode = 1
}
