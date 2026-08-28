import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { formatFromExtension, HEAD_SNIFF_BYTES, sniffFormat, sniffHead, type DocumentFormat } from '../detect.ts'
import { parseDocument } from '../parse/index.ts'
import {
  buildDocumentBlocks,
  documentBlockBuildMetadata,
  INDEX_TRUNCATION_MARKER,
  parseDocumentLocator,
  parseWorkbookInventory,
  retrievalDocumentVersion,
  type DocumentDescriptor,
  type DocumentLocator
} from './blocks.ts'
import { buildQueryPlan } from './tokenize.ts'
import type { CreatedRetrievalBackend } from './runtime.ts'

export interface SearchDocumentsConfig {
  maxFileBytes: number
  maxFiles: number
  maxResults: number
  blockChars: number
  maxBlocksPerDocument: number
  documentTtlMs: number
  queryLogTtlMs: number
  /** Query text can contain private business terms; persistence is opt-in. */
  queryLogEnabled?: boolean
  timeoutMs: number
}

interface SearchDocumentsContext {
  fs: {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
    stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion; type: string; size?: number } | undefined>
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  }
  emit(event: string, target: FsTarget, observation: object, exec: object): void
}

interface ParsedSearchArgs {
  filePaths: string[]
  query?: string
  limit: number
}

interface CachedSource {
  fsVersion: string
  descriptor: DocumentDescriptor
}

interface IndexedMetadata {
  version: string
  sheetIndexes: ReadonlyMap<string, number>
}

function parseArgs(args: Record<string, unknown>, config: SearchDocumentsConfig): ParsedSearchArgs {
  if (!Array.isArray(args.file_paths) || args.file_paths.length === 0) {
    throw new Error('file_paths must be a non-empty array of document paths')
  }
  if (args.file_paths.length > config.maxFiles) {
    throw new Error(`file_paths must contain at most ${config.maxFiles} documents`)
  }
  const filePaths: string[] = []
  const seen = new Set<string>()
  for (const value of args.file_paths) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error('every file_paths item must be a non-empty string')
    const path = value.trim().normalize('NFC')
    if (!seen.has(path)) {
      seen.add(path)
      filePaths.push(path)
    }
  }
  let query: string | undefined
  if (args.query !== undefined) {
    if (typeof args.query !== 'string') throw new Error('query must be a string when provided')
    const candidate = args.query.trim().normalize('NFC')
    if (candidate !== '') {
      const plan = buildQueryPlan(candidate)
      if (plan.phrases.length === 0 && plan.singleCharacters.length === 0) {
        throw new Error('query must contain at least one letter, number, or CJK character')
      }
      query = candidate
    }
  }
  const limit = args.limit === undefined ? config.maxResults : args.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > config.maxResults) {
    throw new Error(`limit must be an integer from 1 to ${config.maxResults}`)
  }
  return { filePaths, query, limit }
}

function hashBytes(value: Uint8Array | string): string {
  return createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex')
}

function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}

function detectedFormat(bytes: Uint8Array, path: string): DocumentFormat | null {
  const head = bytes.subarray(0, Math.min(HEAD_SNIFF_BYTES, bytes.length))
  const headFormat = sniffHead(head)
  if (headFormat === 'zip' || headFormat === null) {
    return sniffFormat(bytes, formatFromExtension(path) ?? undefined)
  }
  return headFormat
}

interface ReadSource {
  target: FsTarget
  version: FsVersion
  bytes?: Uint8Array
  descriptor: DocumentDescriptor
}

async function readSource(
  ctx: SearchDocumentsContext,
  path: string,
  cwd: string | undefined,
  config: SearchDocumentsConfig,
  exec: { signal: AbortSignal },
  sourceCache: Map<string, CachedSource>
): Promise<ReadSource> {
  const target = await ctx.fs.resolve(path, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot index "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') throw new FsError(`cannot index "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  if (info.size !== undefined && info.size > config.maxFileBytes) {
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    throw new FsError(
      `cannot index "${target.displayPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`,
      'FS_TOO_LARGE'
    )
  }
  const targetKey = String(target.targetKey)
  const fsVersion = String(info.version)
  const cached = sourceCache.get(targetKey)
  if (cached?.fsVersion === fsVersion) {
    const descriptor = {
      ...cached.descriptor,
      path: target.displayPath.normalize('NFC')
    }
    // Refresh insertion order so the bounded map behaves as a small LRU.
    sourceCache.delete(targetKey)
    sourceCache.set(targetKey, { fsVersion, descriptor })
    return { target, version: info.version, descriptor }
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes)
  const format = detectedFormat(bytes, path)
  if (format === null) {
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    throw new FsError(
      `cannot index "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX, XLSX or PPTX)`,
      'FS_NOT_TEXT'
    )
  }
  const descriptor: DocumentDescriptor = {
    id: hashBytes(targetKey),
    path: target.displayPath.normalize('NFC'),
    format,
    version: retrievalDocumentVersion(bytes)
  }
  sourceCache.delete(targetKey)
  sourceCache.set(targetKey, { fsVersion, descriptor })
  while (sourceCache.size > 256) {
    const oldest = sourceCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    sourceCache.delete(oldest)
  }
  return {
    target,
    version: info.version,
    bytes,
    descriptor
  }
}

async function bytesForIndex(
  ctx: SearchDocumentsContext,
  source: ReadSource,
  config: SearchDocumentsConfig,
  signal: AbortSignal
): Promise<Uint8Array> {
  const bytes = source.bytes ?? await ctx.fs.readBytes(source.target, signal, config.maxFileBytes)
  if (retrievalDocumentVersion(bytes) !== source.descriptor.version) {
    throw new Error(`cannot index "${source.target.displayPath}": file changed while it was being indexed; retry the search`)
  }
  return bytes
}

interface SearchResultLocator {
  kind: DocumentLocator['kind'] | 'unknown'
  page?: number
  slide?: number
  lineStart?: number
  lineEnd?: number
  sheet?: string
  sheetIndex?: number
  cellRange?: string
  part?: number
}

interface SearchDocumentsValue {
  mode: 'index' | 'search'
  query: string
  backend: string
  backendNotice?: string
  indexedDocuments: number
  documents: Array<{ path: string; format: string; version: string }>
  truncatedDocuments: Array<{ path: string; version: string; maxBlocks: number }>
  results: Array<{
    path: string
    format: string
    version: string
    coordinate: string
    locator: SearchResultLocator
    heading: string
    text: string
  }>
}

function locatorOutput(locator: DocumentLocator | null): SearchResultLocator {
  if (locator === null) return { kind: 'unknown' }
  if (locator.kind === 'page') {
    return {
      kind: locator.kind,
      page: locator.page,
      ...(locator.startLine === undefined ? {} : { lineStart: locator.startLine, lineEnd: locator.endLine })
    }
  }
  if (locator.kind === 'slide') {
    return {
      kind: locator.kind,
      slide: locator.slide,
      ...(locator.startLine === undefined ? {} : { lineStart: locator.startLine, lineEnd: locator.endLine })
    }
  }
  if (locator.kind === 'line') {
    return { kind: locator.kind, lineStart: locator.startLine, lineEnd: locator.endLine }
  }
  return {
    kind: locator.kind,
    sheet: locator.sheet,
    ...(locator.sheetIndex === undefined ? {} : { sheetIndex: locator.sheetIndex }),
    cellRange: locator.cellRange,
    ...(locator.part === undefined ? {} : { part: locator.part })
  }
}

export function renderSearchDocumentsResult(value: SearchDocumentsValue): string {
  const backendNotice = value.backendNotice === undefined ? [] : [`NOTICE: ${value.backendNotice}`]
  const warnings = value.truncatedDocuments.map((document) =>
    `WARNING: ${document.path} index was truncated at ${document.maxBlocks} blocks [version ${document.version}]. Later content may require read_document coordinate expansion or sequential paging.`
  )
  if (value.mode === 'index') {
    const header = `### document index — ${value.documents.length} document(s); backend ${value.backend}; newly indexed ${value.indexedDocuments}`
    const documents = value.documents.map((document, index) =>
      `${index + 1}. ${document.path} (${document.format}) [version ${document.version}]`
    )
    return [
      header,
      ...backendNotice,
      ...documents,
      ...warnings,
      'Index ready. No document body text was returned; use search_documents with a short query when the user asks a concrete question.'
    ].join('\n')
  }
  const header = `### document search — ${value.results.length} result(s); backend ${value.backend}; query ${JSON.stringify(value.query)}`
  if (value.results.length === 0) {
    return [
      header,
      ...backendNotice,
      ...warnings,
      'No matching evidence found in the selected documents. Retry with shorter or different keywords. If the fact should exist, use read_document with a known coordinate or page sequentially with offset/limit. Do not answer from assumptions when evidence is absent.'
    ].join('\n')
  }
  const parts = value.results.map((result, index) => [
    `${index + 1}. ${result.path} (${result.format}) @ ${result.coordinate} [version ${result.version}]`,
    result.heading,
    result.text
  ].filter((entry, entryIndex) => entryIndex === 0 || entry.trim() !== '').join('\n'))
  return [header, ...backendNotice, ...warnings, ...parts].join('\n\n')
}

/** Model-facing local retrieval tool. Parsing remains delegated to src/parse/*. */
export function defineSearchDocumentsTool(
  ctx: SearchDocumentsContext,
  config: SearchDocumentsConfig,
  createdBackend: Promise<CreatedRetrievalBackend>
) {
  const indexing = new Map<string, Promise<void>>()
  const sourceCache = new Map<string, CachedSource>()
  const indexedMetadata = new Map<string, IndexedMetadata>()
  let lastGcAt = 0

  return defineTool({
    name: 'search_documents',
    description:
      'Index or search selected PDF/DOCX/XLSX/PPTX/text files locally before reading long documents. Omit query when the user asks to first read, understand or prepare files without a concrete question: this builds the private index and returns only a compact inventory, not document body text. For a concrete question, pass a short keyword or exact phrase (omit question filler) to receive versioned page/line/Sheet!Range/slide evidence plus a machine locator. Expand evidence by passing the returned coordinate and version unchanged to read_document; do not use Python or Bash for supported files.',
    parameters: {
      file_paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Relevant document paths (maximum ${config.maxFiles}); include all files needed for cross-file questions.`
      },
      query: {
        type: 'string',
        description: 'Optional short keywords or one exact phrase. Omit to index/prepare the files without returning body text. Chinese phrase order is preserved; Q3/IPD-style tokens remain whole.'
      },
      limit: {
        type: 'integer',
        description: `Maximum evidence blocks to return (1-${config.maxResults}, default ${config.maxResults}).`
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['index', 'search'] },
          query: { type: 'string', required: true },
          backend: { type: 'string', required: true, enum: ['sqlite-fts5', 'js-memory'] },
          backendNotice: { type: 'string' },
          indexedDocuments: { type: 'integer', required: true },
          documents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'pptx', 'text'] },
                version: { type: 'string', required: true }
              }
            }
          },
          truncatedDocuments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                version: { type: 'string', required: true },
                maxBlocks: { type: 'integer', required: true }
              }
            }
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'pptx', 'text'] },
                version: { type: 'string', required: true },
                coordinate: { type: 'string', required: true },
                locator: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true, enum: ['page', 'slide', 'line', 'sheet', 'unknown'] },
                    page: { type: 'integer' },
                    slide: { type: 'integer' },
                    lineStart: { type: 'integer' },
                    lineEnd: { type: 'integer' },
                    sheet: { type: 'string' },
                    sheetIndex: { type: 'integer' },
                    cellRange: { type: 'string' },
                    part: { type: 'integer' }
                  }
                },
                heading: { type: 'string', required: true },
                text: { type: 'string', required: true },
                score: { type: 'number', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchDocumentsResult(value) }],
      presentationMeta: (_args, value) => value
    },
    isConcurrencySafe: () => true,
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const input = parseArgs(args, config)
      const cwd = sessionCwd(exec)
      const { backend, report } = await createdBackend
      const backendNotice = report.backend === 'js-memory'
        ? `Non-persistent JS fallback active${report.fallbackReason === undefined ? '' : `: ${report.fallbackReason}`}`
        : undefined
      const sources: ReadSource[] = []
      let indexedDocuments = 0
      for (const path of input.filePaths) {
        const source = await readSource(ctx, path, cwd, config, exec, sourceCache)
        sources.push(source)
        while (backend.documentVersion(source.descriptor.id) !== source.descriptor.version) {
          const pending = indexing.get(source.descriptor.id)
          if (pending !== undefined) {
            await pending
            exec.signal.throwIfAborted()
            continue
          }
          const task = (async () => {
            const bytes = await bytesForIndex(ctx, source, config, exec.signal)
            const blocks = await buildDocumentBlocks(bytes, source.descriptor, {
              blockChars: config.blockChars,
              maxBlocks: config.maxBlocksPerDocument,
              signal: exec.signal
            })
            const metadata = documentBlockBuildMetadata(blocks)
            if (backend.replaceDocumentCooperatively !== undefined) {
              await backend.replaceDocumentCooperatively(source.descriptor, blocks, Date.now())
            } else {
              backend.replaceDocument(source.descriptor, blocks, Date.now())
            }
            indexedMetadata.set(source.descriptor.id, {
              version: source.descriptor.version,
              sheetIndexes: metadata.sheetIndexes
            })
          })()
          indexing.set(source.descriptor.id, task)
          indexedDocuments += 1
          try {
            await task
          } finally {
            if (indexing.get(source.descriptor.id) === task) indexing.delete(source.descriptor.id)
          }
        }
        ctx.emit('fs/observed', source.target, { kind: 'present', version: source.version }, exec)
      }
      const now = Date.now()
      const documentIds = [...new Set(sources.map((source) => source.descriptor.id))]
      backend.touchDocuments(documentIds, now)
      if (now - lastGcAt >= 60 * 60 * 1000) {
        backend.gc(now, config.documentTtlMs, config.queryLogTtlMs)
        lastGcAt = now
      }
      const descriptors = sources.map((source) => source.descriptor)
      const truncatedDocuments = descriptors.flatMap((document) => {
        const hit = backend.search(buildQueryPlan(INDEX_TRUNCATION_MARKER), [document.id], 1)
          .find((candidate) => candidate.text.includes(INDEX_TRUNCATION_MARKER))
        if (hit === undefined) return []
        const recordedLimit = /Index truncated at (\d+) blocks/u.exec(hit.text)
        return [{
          path: document.path,
          version: document.version,
          maxBlocks: recordedLimit === null ? config.maxBlocksPerDocument : Number(recordedLimit[1])
        }]
      })
      // Keep backend-only identifiers out of the model-facing value. The
      // declared output schema intentionally exposes only readable document
      // identity, and Harness rejects undeclared properties fail-closed.
      const documents = descriptors.map(({ path, format, version }) => ({ path, format, version }))
      if (input.query === undefined) {
        return {
          mode: 'index' as const,
          query: '',
          backend: backend.kind,
          ...(backendNotice === undefined ? {} : { backendNotice }),
          indexedDocuments,
          documents,
          truncatedDocuments,
          results: []
        }
      }
      const plan = buildQueryPlan(input.query)
      const results = backend.search(plan, documentIds, input.limit)
      if (config.queryLogEnabled === true) {
        backend.logQuery(plan.normalizedQuery, documentIds, results.length, now)
      }
      const sourcesById = new Map(sources.map((source) => [source.descriptor.id, source]))
      for (const result of results) {
        if (result.format !== 'xlsx') continue
        const known = indexedMetadata.get(result.documentId)
        if (known?.version === result.version) continue
        const source = sourcesById.get(result.documentId)
        if (source === undefined) continue
        const bytes = await bytesForIndex(ctx, source, config, exec.signal)
        const inventory = await parseDocument(bytes, 'xlsx', { sheetRowLimit: 1, listOnly: true })
        indexedMetadata.set(result.documentId, {
          version: result.version,
          sheetIndexes: new Map(parseWorkbookInventory(inventory).map((sheet) => [sheet.name, sheet.index]))
        })
      }
      return {
        mode: 'search' as const,
        query: plan.normalizedQuery,
        backend: backend.kind,
        ...(backendNotice === undefined ? {} : { backendNotice }),
        indexedDocuments,
        documents,
        truncatedDocuments,
        results: results.map(({ documentId, ...result }) => ({
          ...result,
          locator: locatorOutput(parseDocumentLocator(
            result.coordinate,
            indexedMetadata.get(documentId)?.sheetIndexes
          ))
        }))
      }
    },
    presentCall(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      return {
        card: 'generic',
        title: query === '' ? 'Index documents' : `Search documents: ${query}`,
        kind: 'read',
        locations: args.file_paths.map((path) => ({ path }))
      }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const value = result.meta as SearchDocumentsValue | undefined
      if (value === undefined) return undefined
      return {
        card: 'generic',
        title: value.mode === 'index'
          ? `Document index (${value.documents.length})`
          : `Document search (${value.results.length})`,
        content: [{ type: 'text', text: renderSearchDocumentsResult(value) }]
      }
    }
  })
}
