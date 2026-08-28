import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import {
  buildDocumentBlocks,
  documentBlockBuildMetadata,
  formatWorksheetName,
  INDEX_TRUNCATION_MARKER,
  parseDocumentLocator,
  parseWorkbookInventory,
  retrievalDocumentVersion,
  type DocumentBlock,
  type DocumentDescriptor
} from '../src/retrieval/blocks.ts'
import { MemoryRetrievalBackend, SqliteRetrievalBackend, searchBackend, type RetrievalBackend } from '../src/retrieval/backend.ts'
import { buildQueryPlan, containsTokenPhrase, tokenizeForIndex } from '../src/retrieval/tokenize.ts'
import { createRetrievalBackend, probeRetrievalRuntime } from '../src/retrieval/runtime.ts'
import { defineSearchDocumentsTool, renderSearchDocumentsResult } from '../src/retrieval/tool.ts'

test('Chinese bigrams preserve phrase order while ASCII-number tokens stay whole', () => {
  const plan = buildQueryPlan('流程绩效 Q3-IPD')
  assert.equal(plan.ftsQuery, '"流程 程绩 绩效" AND "q3" AND "ipd"')
  assert.equal(plan.relaxedFtsQuery, '"流程 程绩 绩效" OR "q3" OR "ipd"')
  assert.deepEqual(tokenizeForIndex('流程绩效 Q3-IPD'), ['流程', '程绩', '绩效', 'q3', 'ipd'])
  assert.equal(containsTokenPhrase(tokenizeForIndex('流程绩效'), plan.phrases[0]), true)
  assert.equal(containsTokenPhrase(tokenizeForIndex('绩效流程'), plan.phrases[0]), false)
})

test('single CJK characters use a substring plan and search text uses NFKC', () => {
  const plan = buildQueryPlan('税 Cafe\u0301')
  assert.deepEqual(plan.singleCharacters, ['税'])
  assert.equal(plan.normalizedQuery, '税 Café')
  assert.equal(plan.ftsQuery, '"café"')
  assert.deepEqual(tokenizeForIndex('核⼼价值'), tokenizeForIndex('核心价值'))
})

function manualFixture(): { descriptor: DocumentDescriptor; blocks: DocumentBlock[] } {
  const descriptor: DocumentDescriptor = {
    id: 'doc-1',
    path: '/synthetic/metrics.xlsx',
    format: 'xlsx',
    version: 'version-1'
  }
  const values = [
    ['流程绩效及时率', '指标总览!A4:F4', 'MET-HR-02 Q3 95% 流程绩效'],
    ['反向干扰项', '指标总览!A8:F8', 'DISTRACTOR-REVERSED 绩效流程'],
    ['税务及时率', '指标总览!A5:F5', 'MET-TAX-01 税 99%'],
    ['IPD 分工', '流程域分工!A3:D3', 'Q3-IPD Synthetic PMO']
  ]
  return {
    descriptor,
    blocks: values.map(([heading, coordinate, text], index) => ({
      id: `block-${index + 1}`,
      documentId: descriptor.id,
      version: descriptor.version,
      ordinal: index + 1,
      heading,
      coordinate,
      text
    }))
  }
}

function backendPair(): RetrievalBackend[] {
  return [
    new MemoryRetrievalBackend(),
    new SqliteRetrievalBackend(new DatabaseSync(':memory:'))
  ]
}

test('SQLite FTS5 and JS fallback agree on order, single-char and mixed-token retrieval', () => {
  const fixture = manualFixture()
  const backends = backendPair()
  try {
    for (const backend of backends) backend.replaceDocument(fixture.descriptor, fixture.blocks, 1_000)
    for (const query of ['流程绩效', '税', 'Q3 IPD']) {
      const coordinates = backends.map((backend) =>
        searchBackend(backend, query, [fixture.descriptor.id], 5).map((hit) => hit.coordinate)
      )
      assert.deepEqual(coordinates[0], coordinates[1], `${query}: backend results diverged`)
      assert.ok(coordinates[0].length > 0, `${query}: expected a hit`)
    }
    for (const backend of backends) {
      const ordered = searchBackend(backend, '流程绩效', [fixture.descriptor.id], 5)
      assert.equal(ordered[0].coordinate, '指标总览!A4:F4')
      assert.equal(ordered.some((hit) => hit.text.includes('DISTRACTOR-REVERSED')), false)
      assert.equal(searchBackend(backend, 'Q4', [fixture.descriptor.id], 5).length, 0)
    }
  } finally {
    for (const backend of backends) backend.close()
  }
})

test('strict multi-segment queries fall back to ordered phrase groups joined by OR', () => {
  const fixture = manualFixture()
  const backends = backendPair()
  try {
    for (const backend of backends) backend.replaceDocument(fixture.descriptor, fixture.blocks, 1_000)
    const coordinates = backends.map((backend) =>
      searchBackend(backend, 'Q3 missing-token', [fixture.descriptor.id], 5).map((hit) => hit.coordinate)
    )
    for (const result of coordinates) assert.ok(result.includes('流程域分工!A3:D3'))
  } finally {
    for (const backend of backends) backend.close()
  }
})

test('a longer single CJK phrase uses a bounded bigram fallback after an exact miss', () => {
  const fixture = manualFixture()
  fixture.blocks = [{
    ...fixture.blocks[0],
    id: 'partial-cjk',
    heading: '流程说明',
    text: '只包含流程，不包含完整查询短语'
  }]
  const plan = buildQueryPlan('流程绩效')
  assert.equal(plan.relaxedFtsQuery, '"流程" OR "程绩" OR "绩效"')
  const backends = backendPair()
  try {
    for (const backend of backends) {
      backend.replaceDocument(fixture.descriptor, fixture.blocks, 1_000)
      assert.equal(searchBackend(backend, '流程绩效', [fixture.descriptor.id], 5)[0]?.coordinate, '指标总览!A4:F4')
    }
  } finally {
    for (const backend of backends) backend.close()
  }
})

test('SQLite applies NFKC single-character filters before its candidate limit', () => {
  const descriptor: DocumentDescriptor = {
    id: 'candidate-cap',
    path: '/synthetic/candidate-cap.txt',
    format: 'text',
    version: 'v1'
  }
  const blocks: DocumentBlock[] = Array.from({ length: 240 }, (_, index) => ({
    id: `candidate-${index}`,
    documentId: descriptor.id,
    version: descriptor.version,
    ordinal: index + 1,
    coordinate: `line:${index + 1}`,
    heading: 'Q3 candidate',
    text: index === 239 ? 'Q3 ⼼ 税 final evidence' : `Q3 distractor ${index}`
  }))
  const backends = backendPair()
  try {
    for (const backend of backends) backend.replaceDocument(descriptor, blocks, 1_000)
    for (const query of ['Q3 税', '心']) {
      const coordinates = backends.map((backend) =>
        searchBackend(backend, query, [descriptor.id], 5).map((hit) => hit.coordinate)
      )
      assert.deepEqual(coordinates[0], coordinates[1], `${query}: backend results diverged`)
      assert.deepEqual(coordinates[0], ['line:240'])
    }
  } finally {
    for (const backend of backends) backend.close()
  }
})

test('replacing a content version removes stale blocks and TTL GC removes private state', () => {
  const fixture = manualFixture()
  const nextDescriptor = { ...fixture.descriptor, version: 'version-2' }
  const nextBlocks = fixture.blocks.map((block, index) => ({
    ...block,
    id: `version-2-block-${index + 1}`,
    version: nextDescriptor.version,
    text: index === 0 ? 'MET-HR-03 Q4 97% 新版流程绩效' : block.text
  }))
  const backends = backendPair()
  try {
    for (const backend of backends) {
      backend.replaceDocument(fixture.descriptor, fixture.blocks, 1_000)
      backend.replaceDocument(nextDescriptor, nextBlocks, 2_000)
      assert.equal(backend.documentVersion(fixture.descriptor.id), 'version-2')
      assert.equal(searchBackend(backend, '95', [fixture.descriptor.id], 5).some((hit) => hit.coordinate === '指标总览!A4:F4'), false)
      assert.equal(searchBackend(backend, '97', [fixture.descriptor.id], 5)[0]?.coordinate, '指标总览!A4:F4')
      backend.logQuery('MET-HR-03', [fixture.descriptor.id], 1, 2_000)
      assert.deepEqual(backend.gc(3_000, 500, 500), { documents: 1, queries: 1 })
      assert.equal(backend.documentVersion(fixture.descriptor.id), undefined)
    }
  } finally {
    for (const backend of backends) backend.close()
  }
})

test('cooperative SQLite replacement yields and never exposes a partial index', async () => {
  const descriptor: DocumentDescriptor = {
    id: 'cooperative',
    path: '/synthetic/cooperative.txt',
    format: 'text',
    version: 'v-cooperative'
  }
  const blocks: DocumentBlock[] = Array.from({ length: 1_200 }, (_, index) => ({
    id: `cooperative-${index}`,
    documentId: descriptor.id,
    version: descriptor.version,
    ordinal: index + 1,
    coordinate: `line:${index + 1}`,
    heading: 'cooperative indexing',
    text: `uniqueEvidence${index}`
  }))
  const backend = new SqliteRetrievalBackend(new DatabaseSync(':memory:'))
  let anotherTurnRan = false
  try {
    const replacement = backend.replaceDocumentCooperatively(descriptor, blocks, 1_000)
    setImmediate(() => { anotherTurnRan = true })
    assert.match(backend.documentVersion(descriptor.id) ?? '', /^pending:/u)
    assert.deepEqual(searchBackend(backend, 'uniqueEvidence1199', [descriptor.id], 5), [])
    await replacement
    assert.equal(anotherTurnRan, true)
    assert.equal(backend.documentVersion(descriptor.id), descriptor.version)
    assert.equal(searchBackend(backend, 'uniqueEvidence1199', [descriptor.id], 5)[0]?.coordinate, 'line:1200')
  } finally {
    backend.close()
  }
})

test('cooperative memory replacement yields and publishes atomically', async () => {
  const descriptor: DocumentDescriptor = {
    id: 'cooperative-memory',
    path: '/synthetic/cooperative-memory.txt',
    format: 'text',
    version: 'v-cooperative-memory'
  }
  const blocks: DocumentBlock[] = Array.from({ length: 1_200 }, (_, index) => ({
    id: `cooperative-memory-${index}`,
    documentId: descriptor.id,
    version: descriptor.version,
    ordinal: index + 1,
    coordinate: `line:${index + 1}`,
    heading: 'cooperative memory indexing',
    text: `memoryEvidence${index}`
  }))
  const backend = new MemoryRetrievalBackend()
  let anotherTurnRan = false
  try {
    const replacement = backend.replaceDocumentCooperatively(descriptor, blocks, 1_000)
    setImmediate(() => { anotherTurnRan = true })
    assert.equal(backend.documentVersion(descriptor.id), undefined)
    assert.deepEqual(searchBackend(backend, 'memoryEvidence1199', [descriptor.id], 5), [])
    await replacement
    assert.equal(anotherTurnRan, true)
    assert.equal(backend.documentVersion(descriptor.id), descriptor.version)
    assert.equal(searchBackend(backend, 'memoryEvidence1199', [descriptor.id], 5)[0]?.coordinate, 'line:1200')
  } finally {
    backend.close()
  }
})

const fixtureDir = join(process.cwd(), 'benchmark', 'fixtures', 'generated')

test('retrieval versions bind content to an explicit parser/block schema', () => {
  const bytes = new TextEncoder().encode('stable content')
  const current = retrievalDocumentVersion(bytes)
  assert.match(current, /^retrieval-v2:[0-9a-f]{64}$/u)
  assert.notEqual(current, retrievalDocumentVersion(bytes, 'retrieval-v1'))
  assert.notEqual(current, retrievalDocumentVersion(new TextEncoder().encode('changed content')))
})

test('block limit degrades to an explicit cached truncation marker without exceeding the contract', async () => {
  const bytes = new TextEncoder().encode(Array.from({ length: 20 }, (_, index) => `row-${index}-${'x'.repeat(20)}`).join('\n'))
  const descriptor: DocumentDescriptor = {
    id: 'limited',
    path: '/synthetic/limited.txt',
    format: 'text',
    version: retrievalDocumentVersion(bytes)
  }
  const blocks = await buildDocumentBlocks(bytes, descriptor, { blockChars: 24, maxBlocks: 3 })
  assert.equal(blocks.length, 3)
  assert.equal(documentBlockBuildMetadata(blocks).truncated, true)
  assert.match(blocks.at(-1)?.text ?? '', new RegExp(INDEX_TRUNCATION_MARKER))
  assert.match(blocks.at(-1)?.text ?? '', /later document content is not searchable/)

  const backend = new MemoryRetrievalBackend()
  try {
    backend.replaceDocument(descriptor, blocks, Date.now())
    const marker = backend.search(buildQueryPlan(INDEX_TRUNCATION_MARKER), [descriptor.id], 1)
    assert.equal(marker.length, 1, 'persisted blocks retain machine-detectable truncation state')
    assert.equal(backend.documentVersion(descriptor.id), descriptor.version)
  } finally {
    backend.close()
  }
})

test('XLSX coordinates quote spaces/apostrophes and inventory rejects line-breaking names explicitly', () => {
  assert.equal(formatWorksheetName('指标总览'), '指标总览')
  assert.equal(formatWorksheetName("O'Brien Plan"), "'O''Brien Plan'")
  const locator = parseDocumentLocator("'O''Brien Plan'!A5:F5", new Map([["O'Brien Plan", 3]]))
  assert.deepEqual(locator, {
    kind: 'sheet',
    sheet: "O'Brien Plan",
    sheetIndex: 3,
    cellRange: 'A5:F5'
  })
  assert.throws(
    () => parseWorkbookInventory('### Workbook (1 sheets)\n1. Broken\nName — used A1:A1; 1 populated rows; 1 non-empty cells'),
    /worksheet name.*line break/
  )
})

test('zero-recall rendering gives retry, paging and no-guess guidance', () => {
  const rendered = renderSearchDocumentsResult({
    mode: 'search',
    query: 'missing',
    backend: 'js-memory',
    documentCount: 0,
    indexedDocuments: 0,
    documents: [],
    truncatedDocuments: [],
    results: []
  })
  assert.match(rendered, /Retry with shorter or different keywords/)
  assert.match(rendered, /offset\/limit/)
  assert.match(rendered, /Do not answer from assumptions/)
})

test('search_documents rebuilds a same-content index created by an older retrieval schema', async () => {
  const bytes = new TextEncoder().encode('schema migration evidence')
  const targetKey = 'target:doc.txt'
  const id = createHash('sha256').update(targetKey).digest('hex')
  const backend = new MemoryRetrievalBackend()
  backend.replaceDocument({
    id,
    path: '/workspace/doc.txt',
    format: 'text',
    version: retrievalDocumentVersion(bytes, 'retrieval-v1')
  }, [], Date.now())
  const tool = defineSearchDocumentsTool({
    fs: {
      resolve: async () => ({ targetKey: FsTargetKey(targetKey), displayPath: '/workspace/doc.txt' }),
      stat: async () => ({ version: FsVersion('fs-v1'), type: 'file', size: bytes.length }),
      readBytes: async () => bytes
    },
    emit: () => undefined
  }, {
    maxFileBytes: 1024,
    maxFiles: 2,
    maxResults: 4,
    blockChars: 128,
    maxBlocksPerDocument: 8,
    documentTtlMs: 1000,
    queryLogTtlMs: 1000,
    timeoutMs: 1000
  }, Promise.resolve({
    backend,
    report: { nodeVersion: process.versions.node, backend: 'js-memory', phraseProbe: false }
  }))
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  try {
    const result = await tool.execute({ file_paths: ['doc.txt'] }, exec) as {
      indexedDocuments: number
      documentCount: number
      documents: Array<{ version: string }>
    }
    assert.equal(result.indexedDocuments, 1)
    assert.equal(result.documentCount, 1)
    assert.equal(result.documents[0].version, retrievalDocumentVersion(bytes))
    assert.equal(backend.documentVersion(id), retrievalDocumentVersion(bytes))
  } finally {
    backend.close()
  }
})

test('search_documents caches a truncated document version and reports the persisted block limit', async () => {
  const bytes = new TextEncoder().encode(Array.from({ length: 12 }, (_, index) => `evidence-${index}`).join('\n'))
  let reads = 0
  const backend = new MemoryRetrievalBackend()
  const tool = defineSearchDocumentsTool({
    fs: {
      resolve: async () => ({ targetKey: FsTargetKey('target:large.txt'), displayPath: '/workspace/large.txt' }),
      stat: async () => ({ version: FsVersion('fs-v1'), type: 'file', size: bytes.length }),
      readBytes: async () => {
        reads += 1
        return bytes
      }
    },
    emit: () => undefined
  }, {
    maxFileBytes: 1024,
    maxFiles: 2,
    maxResults: 4,
    blockChars: 12,
    maxBlocksPerDocument: 2,
    documentTtlMs: 1000,
    queryLogTtlMs: 1000,
    timeoutMs: 1000
  }, Promise.resolve({
    backend,
    report: { nodeVersion: process.versions.node, backend: 'js-memory', phraseProbe: false }
  }))
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  try {
    for (const expectedIndexed of [1, 0]) {
      const result = await tool.execute({ file_paths: ['large.txt'] }, exec) as {
        indexedDocuments: number
        documentCount: number
        truncatedDocuments: Array<{ maxBlocks: number; version: string }>
      }
      assert.equal(result.indexedDocuments, expectedIndexed)
      assert.equal(result.documentCount, 1)
      assert.equal(result.truncatedDocuments.length, 1)
      assert.equal(result.truncatedDocuments[0].maxBlocks, 2)
      assert.equal(result.truncatedDocuments[0].version, retrievalDocumentVersion(bytes))
    }
    assert.equal(reads, 1, 'truncated version is accepted as indexed and is not reparsed')
  } finally {
    backend.close()
  }
})

async function descriptor(file: string, format: DocumentDescriptor['format'], id: string): Promise<{ bytes: Uint8Array; descriptor: DocumentDescriptor }> {
  const bytes = new Uint8Array(await readFile(join(fixtureDir, file)))
  return {
    bytes,
    descriptor: { id, path: `/synthetic/${file.normalize('NFC')}`, format, version: `v-${id}` }
  }
}

test('synthetic PDF/XLSX/DOCX/PPTX build coordinate-bearing blocks', async () => {
  const pdf = await descriptor('atlas-kickoff.pdf', 'pdf', 'pdf')
  const xlsx = await descriptor('atlas-metrics.xlsx', 'xlsx', 'xlsx')
  const docx = await descriptor('流程绩效-Café会议纪要.docx', 'docx', 'docx')
  const pptx = await descriptor('atlas-strategy.pptx', 'pptx', 'pptx')
  const options = { blockChars: 1600, maxBlocks: 20_000 }
  const [pdfBlocks, xlsxBlocks, docxBlocks, pptxBlocks] = await Promise.all([
    buildDocumentBlocks(pdf.bytes, pdf.descriptor, options),
    buildDocumentBlocks(xlsx.bytes, xlsx.descriptor, options),
    buildDocumentBlocks(docx.bytes, docx.descriptor, options),
    buildDocumentBlocks(pptx.bytes, pptx.descriptor, options)
  ])
  assert.ok(pdfBlocks.some((block) => block.coordinate.startsWith('page:2') && block.text.includes('R-42')))
  assert.ok(xlsxBlocks.some((block) => block.coordinate === '指标总览!A4:F4' && block.text.includes('MET-HR-02')))
  assert.ok(xlsxBlocks.some((block) => block.coordinate === '稀疏数据!A200:Z200' && block.text.includes('SPARSE-ANCHOR-200')))
  assert.ok(docxBlocks.some((block) => block.coordinate.startsWith('line') && block.text.includes('AX-17')))
  assert.ok(pptxBlocks.some((block) => block.coordinate === 'slide:2' && block.text.includes('Synthetic Strategy PMO')))
})

test('search_documents index mode returns a compact inventory before query retrieval', async () => {
  const files = new Map<string, Uint8Array>()
  for (const file of ['atlas-kickoff.pdf', 'atlas-metrics.xlsx', '流程绩效-Café会议纪要.docx', 'atlas-strategy.pptx']) {
    files.set(file, new Uint8Array(await readFile(join(fixtureDir, file))))
  }
  const observations: string[] = []
  let readCount = 0
  const backend = new MemoryRetrievalBackend()
  let queryLogCalls = 0
  const originalLogQuery = backend.logQuery.bind(backend)
  backend.logQuery = (query, documentIds, resultCount, now) => {
    queryLogCalls += 1
    originalLogQuery(query, documentIds, resultCount, now)
  }
  const tool = defineSearchDocumentsTool(
    {
      fs: {
        resolve: async (path) => {
          const file = path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path
          return { targetKey: FsTargetKey(`target:${file}`), displayPath: `/workspace/${file}` }
        },
        stat: async (target) => {
          const file = target.displayPath.slice('/workspace/'.length)
          const bytes = files.get(file)
          return bytes === undefined ? undefined : { version: FsVersion('v1'), type: 'file', size: bytes.length }
        },
        readBytes: async (target) => {
          readCount += 1
          const file = target.displayPath.slice('/workspace/'.length)
          const bytes = files.get(file)
          if (bytes === undefined) throw new Error(`missing synthetic file ${file}`)
          return bytes
        }
      },
      emit: (_event, target) => observations.push(target.displayPath)
    },
    {
      maxFileBytes: 24 * 1024 * 1024,
      maxFiles: 12,
      maxResults: 12,
      blockChars: 1600,
      maxBlocksPerDocument: 20_000,
      documentTtlMs: 30 * 24 * 60 * 60 * 1000,
      queryLogEnabled: false,
      queryLogTtlMs: 30 * 24 * 60 * 60 * 1000,
      timeoutMs: 120_000
    },
    Promise.resolve({
      backend,
      report: { nodeVersion: process.versions.node, backend: 'js-memory', phraseProbe: false }
    })
  )
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: '/workspace' } } }
  } as unknown as Parameters<typeof tool.execute>[1]
  const indexArgs = {
    file_paths: [...files.keys()].map((file) => `/workspace/${file}`)
  }
  const searchArgs = {
    file_paths: [...files.keys()].map((file) => `/workspace/${file}`),
    query: 'R-42',
    limit: 12
  }
  try {
    const indexed = await tool.execute(indexArgs, exec) as {
      mode: string
      query: string
      backend: string
      documentCount: number
      indexedDocuments: number
      backendNotice?: string
      documents: Array<{ path: string; format: string; version: string }>
      results: unknown[]
    }
    assert.equal(indexed.mode, 'index')
    assert.equal(indexed.query, '')
    assert.equal(indexed.backend, 'js-memory')
    assert.equal(indexed.backendNotice, 'Non-persistent JS fallback active')
    assert.equal(indexed.documentCount, 4)
    assert.equal(indexed.indexedDocuments, 4)
    assert.equal(indexed.documents.length, 4)
    assert.deepEqual(Object.keys(indexed.documents[0]).sort(), ['format', 'path', 'version'])
    assert.deepEqual(indexed.documents.map((document) => document.path), [...files.keys()])
    assert.deepEqual(indexed.results, [])

    const first = await tool.execute(searchArgs, exec) as {
      mode: string
      backend: string
      documentCount: number
      indexedDocuments: number
      truncatedDocuments: unknown[]
      results: Array<{
        path: string
        coordinate: string
        locator: { kind: string; page?: number; sheet?: string; sheetIndex?: number; cellRange?: string }
        text: string
      }>
    }
    assert.equal(first.mode, 'search')
    assert.equal(first.backend, 'js-memory')
    assert.equal(first.documentCount, 4)
    assert.equal(first.indexedDocuments, 0)
    assert.deepEqual(first.truncatedDocuments, [])
    assert.ok(first.results.some((result) =>
      result.path.endsWith('.pdf') && result.coordinate === 'page:2' && result.locator.page === 2
    ))
    assert.ok(first.results.some((result) =>
      result.coordinate === '隐藏映射!A2:C2' &&
      result.locator.sheet === '隐藏映射' &&
      result.locator.sheetIndex === 3 &&
      result.locator.cellRange === 'A2:C2'
    ))
    const second = await tool.execute(searchArgs, exec) as { indexedDocuments: number }
    assert.equal(second.indexedDocuments, 0)
    assert.equal(readCount, 4, 'unchanged fs versions should not reread full file bytes')
    assert.equal(queryLogCalls, 0, 'private query persistence stays disabled unless explicitly enabled')
    assert.equal(observations.length, 12)
  } finally {
    backend.close()
  }
})

test('runtime probe is functional and forced failure selects JS fallback', async () => {
  const live = await probeRetrievalRuntime()
  assert.equal(live.backend, 'sqlite-fts5')
  assert.equal(live.phraseProbe, true)
  const failed = await probeRetrievalRuntime(async () => {
    throw new Error('synthetic unavailable runtime')
  })
  assert.equal(failed.backend, 'js-memory')
  assert.equal(failed.phraseProbe, false)
  assert.match(failed.fallbackReason ?? '', /synthetic unavailable runtime/)
})

test('persistent backend creates a private directory and database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-retrieval-'))
  const indexDir = join(root, 'private-index')
  const messages: string[] = []
  try {
    const created = await createRetrievalBackend({
      indexDir,
      logger: {
        info: (...args) => messages.push(args.join(' ')),
        warn: (...args) => messages.push(args.join(' '))
      }
    })
    try {
      assert.equal(created.backend.kind, 'sqlite-fts5')
      assert.equal((await stat(indexDir)).mode & 0o777, 0o700)
      assert.equal((await stat(join(indexDir, 'retrieval.sqlite3'))).mode & 0o777, 0o600)
      assert.equal((await stat(join(indexDir, 'retrieval.sqlite3-wal'))).mode & 0o777, 0o600)
      assert.equal((await stat(join(indexDir, 'retrieval.sqlite3-shm'))).mode & 0o777, 0o600)
      assert.ok(messages.some((message) => message.includes('retrieval self-check')))
    } finally {
      created.backend.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-existing shared index directory fails safely to memory without chmod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-retrieval-shared-'))
  const indexDir = join(root, 'shared-index')
  try {
    await mkdir(indexDir, { mode: 0o755 })
    await chmod(indexDir, 0o755)
    const created = await createRetrievalBackend({
      indexDir,
      logger: { info: () => {}, warn: () => {} }
    })
    try {
      assert.equal(created.backend.kind, 'js-memory')
      assert.match(created.report.fallbackReason ?? '', /mode 0700/)
      assert.equal((await stat(indexDir)).mode & 0o777, 0o755)
    } finally {
      created.backend.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
