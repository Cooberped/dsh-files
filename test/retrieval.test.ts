import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { buildDocumentBlocks, type DocumentBlock, type DocumentDescriptor } from '../src/retrieval/blocks.ts'
import { MemoryRetrievalBackend, SqliteRetrievalBackend, searchBackend, type RetrievalBackend } from '../src/retrieval/backend.ts'
import { buildQueryPlan, containsTokenPhrase, tokenizeForIndex } from '../src/retrieval/tokenize.ts'
import { createRetrievalBackend, probeRetrievalRuntime } from '../src/retrieval/runtime.ts'
import { defineSearchDocumentsTool } from '../src/retrieval/tool.ts'

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

const fixtureDir = join(process.cwd(), 'benchmark', 'fixtures', 'generated')

async function descriptor(file: string, format: DocumentDescriptor['format'], id: string): Promise<{ bytes: Uint8Array; descriptor: DocumentDescriptor }> {
  const bytes = new Uint8Array(await readFile(join(fixtureDir, file)))
  return {
    bytes,
    descriptor: { id, path: `/synthetic/${file.normalize('NFC')}`, format, version: `v-${id}` }
  }
}

test('synthetic PDF/XLSX/DOCX build coordinate-bearing blocks without parser changes', async () => {
  const pdf = await descriptor('atlas-kickoff.pdf', 'pdf', 'pdf')
  const xlsx = await descriptor('atlas-metrics.xlsx', 'xlsx', 'xlsx')
  const docx = await descriptor('流程绩效-Café会议纪要.docx', 'docx', 'docx')
  const options = { blockChars: 1600, maxBlocks: 20_000 }
  const [pdfBlocks, xlsxBlocks, docxBlocks] = await Promise.all([
    buildDocumentBlocks(pdf.bytes, pdf.descriptor, options),
    buildDocumentBlocks(xlsx.bytes, xlsx.descriptor, options),
    buildDocumentBlocks(docx.bytes, docx.descriptor, options)
  ])
  assert.ok(pdfBlocks.some((block) => block.coordinate.startsWith('page:2') && block.text.includes('R-42')))
  assert.ok(xlsxBlocks.some((block) => block.coordinate === '指标总览!A4:F4' && block.text.includes('MET-HR-02')))
  assert.ok(xlsxBlocks.some((block) => block.coordinate === '稀疏数据!A200:Z200' && block.text.includes('SPARSE-ANCHOR-200')))
  assert.ok(docxBlocks.some((block) => block.coordinate.startsWith('line') && block.text.includes('AX-17')))
})

test('search_documents indexes selected files once and returns structured local evidence', async () => {
  const files = new Map<string, Uint8Array>()
  for (const file of ['atlas-kickoff.pdf', 'atlas-metrics.xlsx', '流程绩效-Café会议纪要.docx']) {
    files.set(file, new Uint8Array(await readFile(join(fixtureDir, file))))
  }
  const observations: string[] = []
  let readCount = 0
  const backend = new MemoryRetrievalBackend()
  const tool = defineSearchDocumentsTool(
    {
      fs: {
        resolve: async (path) => ({ targetKey: FsTargetKey(`target:${path}`), displayPath: `/workspace/${path}` }),
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
  const args = {
    file_paths: [...files.keys()],
    query: 'R-42',
    limit: 12
  }
  try {
    const first = await tool.execute(args, exec) as {
      backend: string
      indexedDocuments: number
      results: Array<{ path: string; coordinate: string; text: string }>
    }
    assert.equal(first.backend, 'js-memory')
    assert.equal(first.indexedDocuments, 3)
    assert.ok(first.results.some((result) => result.path.endsWith('.pdf') && result.coordinate === 'page:2'))
    assert.ok(first.results.some((result) => result.coordinate === '隐藏映射!A2:C2'))
    const second = await tool.execute(args, exec) as { indexedDocuments: number }
    assert.equal(second.indexedDocuments, 0)
    assert.equal(readCount, 3, 'unchanged fs versions should not reread full file bytes')
    assert.equal(observations.length, 6)
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
