import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from '../src/parse/index.ts'
import { sniffFormat } from '../src/detect.ts'
import { DEFAULT_FIXTURE_DIR } from './generate-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MANIFEST = join(HERE, 'cases.synthetic.json')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function validateSyntheticFixtureSet({
  fixtureDir = DEFAULT_FIXTURE_DIR,
  manifestPath = DEFAULT_MANIFEST
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert(manifest.schemaVersion === 1, 'synthetic manifest schemaVersion must be 1')
  assert(manifest.privacy === 'synthetic-only', 'synthetic manifest must declare privacy=synthetic-only')
  assert(Array.isArray(manifest.documents) && manifest.documents.length === 3, 'synthetic manifest must contain three documents')
  assert(Array.isArray(manifest.cases) && manifest.cases.length >= 10, 'synthetic manifest must contain at least ten cases')

  const ids = new Set()
  const canonicalNames = new Set()
  const parsedById = new Map()
  for (const document of manifest.documents) {
    assert(typeof document.id === 'string' && document.id !== '', 'document id is required')
    assert(!ids.has(document.id), `duplicate document id: ${document.id}`)
    ids.add(document.id)
    const canonical = document.file.normalize('NFC')
    assert(!canonicalNames.has(canonical), `canonically duplicate fixture name: ${canonical}`)
    canonicalNames.add(canonical)
    const bytes = new Uint8Array(await readFile(join(fixtureDir, document.file)))
    const detected = sniffFormat(bytes)
    assert(detected === document.format, `${document.id}: expected ${document.format}, detected ${detected}`)
    const text = await parseDocument(bytes, document.format, { sheetRowLimit: 500, maxSheets: 20 })
    for (const marker of document.markers) {
      assert(text.includes(marker), `${document.id}: parsed output is missing marker ${marker}`)
    }
    parsedById.set(document.id, text)
    for (const alias of document.unicodeFilenameAliases ?? []) {
      assert(alias !== alias.normalize('NFC'), `${document.id}: unicode alias must use an actual decomposed filename`)
      const aliasBytes = new Uint8Array(await readFile(join(fixtureDir, alias)))
      assert(sniffFormat(aliasBytes) === document.format, `${document.id}: NFD alias must preserve document bytes`)
    }
  }

  const caseIds = new Set()
  const queryClasses = new Set()
  for (const entry of manifest.cases) {
    assert(typeof entry.id === 'string' && entry.id !== '', 'case id is required')
    assert(!caseIds.has(entry.id), `duplicate case id: ${entry.id}`)
    caseIds.add(entry.id)
    queryClasses.add(entry.queryClass)
    assert(typeof entry.question === 'string' && entry.question !== '', `${entry.id}: question is required`)
    assert(Array.isArray(entry.expected?.facts), `${entry.id}: expected.facts must be an array`)
    assert(Array.isArray(entry.expected?.evidence), `${entry.id}: expected.evidence must be an array`)
    assert(Array.isArray(entry.forbiddenFacts), `${entry.id}: forbiddenFacts must be an array`)
    if (entry.expected.noAnswer !== true) {
      assert(entry.expected.facts.length > 0, `${entry.id}: answerable case needs expected facts`)
      assert(entry.expected.evidence.length > 0, `${entry.id}: answerable case needs expected evidence`)
    }
    for (const evidence of entry.expected.evidence) {
      assert(ids.has(evidence.document), `${entry.id}: unknown evidence document ${evidence.document}`)
      assert(typeof evidence.coordinate === 'string' && evidence.coordinate !== '', `${entry.id}: evidence coordinate is required`)
    }
  }
  for (const required of ['exact-cell', 'cross-sheet', 'cross-file', 'sparse-sheet', 'ordered-cjk-phrase', 'single-cjk-character', 'ascii-number-mixed', 'negative']) {
    assert(queryClasses.has(required), `missing required query class: ${required}`)
  }
  return { documents: ids.size, cases: caseIds.size, queryClasses: queryClasses.size, parsedById }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateSyntheticFixtureSet()
  process.stdout.write(`${JSON.stringify({ documents: result.documents, cases: result.cases, queryClasses: result.queryClasses })}\n`)
}
