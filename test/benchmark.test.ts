import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateFixtures } from '../benchmark/generate-fixtures.mjs'
import { validateSyntheticFixtureSet } from '../benchmark/validate-fixtures.mjs'
import { validateRealManifest } from '../benchmark/validate-real-manifest.mjs'

test('synthetic benchmark fixtures are generated and satisfy the gold contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-benchmark-'))
  const fixtureDir = join(root, 'fixtures')
  const outputs = await generateFixtures(fixtureDir)
  assert.deepEqual(outputs.map((entry) => entry.name.normalize('NFC')), [
    'atlas-kickoff.pdf',
    '流程绩效-Café会议纪要.docx',
    'atlas-metrics.xlsx',
    'atlas-strategy.pptx'
  ])
  const result = await validateSyntheticFixtureSet({ fixtureDir })
  assert.equal(result.documents, 4)
  assert.equal(result.cases, 11)
})

test('real benchmark validator refuses manifests stored inside the repository', async () => {
  const manifest = join(process.cwd(), 'benchmark', 'cases.synthetic.json')
  await assert.rejects(validateRealManifest(manifest), /outside the repository/)
})

test('real benchmark validator pins the exact external document hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-real-manifest-'))
  const document = join(root, 'source.pdf')
  const manifest = join(root, 'manifest.json')
  const bytes = Buffer.from('synthetic external fixture')
  await writeFile(document, bytes)
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    privacy: 'local-sensitive',
    documents: [{
      id: 'source',
      path: document,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }],
    cases: [{
      id: 'case',
      question: 'synthetic?',
      expected: { facts: ['yes'], evidence: [{ document: 'source', coordinate: 'page:1' }] }
    }]
  }))

  const result = await validateRealManifest(manifest)
  assert.equal(result.documents, 1)
  await writeFile(document, 'changed')
  await assert.rejects(validateRealManifest(manifest), /sha256 mismatch/)
})
