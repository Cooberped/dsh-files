import assert from 'node:assert/strict'

import { parseDocument } from '../lib/parse/index.js'
import { MemoryRetrievalBackend } from '../lib/retrieval/backend.js'
import { probeRetrievalRuntime } from '../lib/retrieval/runtime.js'
import { buildQueryPlan } from '../lib/retrieval/tokenize.js'

let assertions = 0
const report = await probeRetrievalRuntime()
assert.equal(report.nodeVersion, process.versions.node)
assertions += 1
if (Number(process.versions.node.split('.')[0]) < 22) {
  assert.equal(report.backend, 'js-memory')
  assert.match(report.fallbackReason ?? '', /non-persistent memory index/u)
  assertions += 2
}

const text = await parseDocument(
  new TextEncoder().encode('流程绩效\nQ3 target'),
  'text',
  { sheetRowLimit: 10 }
)
assert.equal(text, '流程绩效\nQ3 target')
assertions += 1

const descriptor = {
  id: 'runtime-smoke',
  path: 'runtime-smoke.txt',
  format: 'text',
  version: 'retrieval-smoke:1'
}
const backend = new MemoryRetrievalBackend()
backend.replaceDocument(descriptor, [{
  id: 'runtime-smoke:1',
  documentId: descriptor.id,
  version: descriptor.version,
  ordinal: 0,
  coordinate: 'line:1',
  heading: 'Runtime smoke',
  text
}], Date.now())
const hits = backend.search(buildQueryPlan('流程绩效'), [descriptor.id], 5)
assert.equal(hits.length, 1)
assert.equal(hits[0].coordinate, 'line:1')
assertions += 2
backend.close()

assert.ok(assertions >= 4, `expected non-zero runtime assertions, got ${assertions}`)
console.log(`runtime smoke passed on Node ${process.versions.node} (${assertions} assertions; ${report.backend})`)
