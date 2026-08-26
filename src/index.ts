// dsh-files — a dual-face DeepSeek Harness plugin: one cordis row, one apply.
// capabilities:
//   1. read_document tool (host): sniffed-format text extraction for
//      text/PDF/DOCX/XLSX/PPTX with size pre-check and LRU parse cache.
//   2. upload surface (host webServer + web client): composer paperclip that
//      stores files per session inside the session workspace and attaches the
//      path to the outgoing message.

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineReadDocumentTool } from './tool.ts'
import { defineSearchDocumentsTool } from './retrieval/tool.ts'
import { createRetrievalBackend } from './retrieval/runtime.ts'
import { createUploadHandler, createSweeper } from './upload.ts'
import { createWorkspaceFilesHandler, DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_EXTENSIONS, DEFAULT_IGNORED_FILES } from './workspace.ts'
import { ParseCache } from './cache.ts'
import { parseHost } from './guard.ts'

/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-files'

/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt', 'webServer', 'sessions']

const MEBIBYTE = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const DSH_HOME = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))

/** Plugin config, mirroring the schemastery schema below. */
export interface DocsConfig {
  maxFileBytes: number
  readLimit: number
  sheetRowLimit: number
  maxSheets: number
  cacheEntries: number
  cacheMaxBytes: number
  maxOutputChars: number
  uploadMaxBytes: number
  allowedExtensions: string[]
  uploadTtlMs: number
  sweepIntervalMs: number
  maxConcurrentUploads: number
  maxUploadBytesPerSession: number
  uploadDir: string
  /** read_document 单次执行超时（ms）。 */
  readTimeoutMs: number
  /** 额外信任的上传 Host（裸 host 匹配任意端口，host:port 精确匹配）；默认空 = 仅回环。 */
  trustedHosts: string[]
  /** @ 工作区候选的最大深度（根为 0）。 */
  workspaceMaxDepth: number
  /** @ 工作区候选的最大文件数。 */
  workspaceMaxFiles: number
  /** 启用本地按需检索工具；关闭后仍保留 read_document。 */
  retrievalEnabled: boolean
  /** 私有 SQLite 索引目录；运行时不支持 FTS5 时仅作探针，不写索引。 */
  retrievalIndexDir: string
  retrievalMaxFiles: number
  retrievalMaxResults: number
  retrievalBlockChars: number
  retrievalMaxBlocksPerDocument: number
  retrievalDocumentTtlMs: number
  retrievalQueryLogTtlMs: number
  retrievalTimeoutMs: number
}

export const Config = z.object({
  /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
  maxFileBytes: z.number().default(24 * MEBIBYTE),
  /** Default and maximum number of lines returned by one call. */
  readLimit: z.number().default(800),
  /** Rows kept per worksheet. */
  sheetRowLimit: z.number().default(200),
  /** Sheets read per workbook (the rest are reported as truncated). */
  maxSheets: z.number().default(5),
  /** Parse-cache capacity (targetKey + version fingerprints). */
  cacheEntries: z.number().default(16),
  /** Parse-cache byte budget; large PDFs dominate retained memory. */
  cacheMaxBytes: z.number().default(64 * MEBIBYTE),
  /** Per-call window character budget (text uses it in full; pdf/docx/pptx get half, xlsx three-quarters). The window is truncated with an explicit marker when exceeded. */
  maxOutputChars: z.number().default(24000),
  /** Byte cap for one upload body. */
  uploadMaxBytes: z.number().default(24 * MEBIBYTE),
  /** Lowercase extension allowlist for uploads; empty means all allowed. */
  allowedExtensions: z.array(z.string()).default([]),
  /** Uploaded files older than this are swept away. */
  uploadTtlMs: z.number().default(7 * DAY_MS),
  /** Sweep interval; 0 disables the periodic sweep. */
  sweepIntervalMs: z.number().default(60 * 60 * 1000),
  /** Concurrent upload bodies admitted at once. */
  maxConcurrentUploads: z.number().default(4),
  /** Per-session storage byte quota; 0 disables the check. */
  maxUploadBytesPerSession: z.number().default(0),
  /** Upload storage root; files land in <root>/.dsh-filess/<sessionId>/. */
  uploadDir: z.string().default(join(process.cwd(), 'uploads')),
  readTimeoutMs: z.number().default(120_000),
  /** 信任的额外上传 Host，兼容公网域名/反向隧道部署（`dsh web --trusted-host` 同源语义）。 */
  trustedHosts: z.array(z.string()).default([]),
  workspaceMaxDepth: z.number().default(12),
  workspaceMaxFiles: z.number().default(500),
  /** Local retrieval is additive: read_document remains the coordinate expander. */
  retrievalEnabled: z.boolean().default(true),
  retrievalIndexDir: z.string().default(join(DSH_HOME, 'dsh-files', 'index')),
  retrievalMaxFiles: z.number().default(12),
  retrievalMaxResults: z.number().default(12),
  retrievalBlockChars: z.number().default(1600),
  retrievalMaxBlocksPerDocument: z.number().default(20_000),
  retrievalDocumentTtlMs: z.number().default(30 * DAY_MS),
  retrievalQueryLogTtlMs: z.number().default(30 * DAY_MS),
  retrievalTimeoutMs: z.number().default(120_000)
})

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-files: ${label} must be a positive integer`)
}

export function apply(ctx: any, config: DocsConfig): void {
  for (const [label, value] of [
    ['maxFileBytes', config.maxFileBytes],
    ['readLimit', config.readLimit],
    ['sheetRowLimit', config.sheetRowLimit],
    ['maxSheets', config.maxSheets],
    ['cacheEntries', config.cacheEntries],
    ['cacheMaxBytes', config.cacheMaxBytes],
    ['maxOutputChars', config.maxOutputChars],
    ['uploadMaxBytes', config.uploadMaxBytes],
    ['uploadTtlMs', config.uploadTtlMs],
    ['sweepIntervalMs', config.sweepIntervalMs],
    ['maxConcurrentUploads', config.maxConcurrentUploads],
    ['retrievalMaxFiles', config.retrievalMaxFiles],
    ['retrievalMaxResults', config.retrievalMaxResults],
    ['retrievalBlockChars', config.retrievalBlockChars],
    ['retrievalMaxBlocksPerDocument', config.retrievalMaxBlocksPerDocument],
    ['retrievalDocumentTtlMs', config.retrievalDocumentTtlMs],
    ['retrievalQueryLogTtlMs', config.retrievalQueryLogTtlMs],
    ['retrievalTimeoutMs', config.retrievalTimeoutMs]
  ] as const) {
    assertPositiveInteger(value, label)
  }
  if (!Number.isInteger(config.maxUploadBytesPerSession) || config.maxUploadBytesPerSession < 0) {
    throw new Error('dsh-files: maxUploadBytesPerSession must be a non-negative integer')
  }
  // 启动时校验 trustedHosts 条目，拼写错误 loud fail（对齐官方 assertTrustedAuthority）。
  for (const entry of config.trustedHosts) {
    if (parseHost(entry) === null) {
      throw new Error(`dsh-files: trustedHosts entry "${entry}" is not a valid host (expected "example.com" or "example.com:443")`)
    }
  }

  const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes)

  if (config.retrievalEnabled) {
    if (config.retrievalIndexDir.trim() === '') throw new Error('dsh-files: retrievalIndexDir must be a non-empty path')
    if (!isAbsolute(config.retrievalIndexDir)) {
      throw new Error('dsh-files: retrievalIndexDir must be an absolute private path (omit it to use the DSH_HOME default)')
    }
    const logger = ctx.logger('dsh-files')
    const createdBackend = createRetrievalBackend({
      indexDir: config.retrievalIndexDir,
      logger
    })
    ctx.systemPrompt.section({
      name: 'tool:search-documents',
      order: 105,
      text: 'For every task involving one or more attached PDF/DOCX/XLSX/PPTX/text files, call search_documents first with every relevant file path. If the user asks to first read, understand, ingest or prepare the files without a concrete question, omit query: this builds the private local index and returns only a compact inventory, so do not pre-read the files with read_document. For a concrete question, pass a short keyword or exact phrase and use the returned versioned page/line/Sheet!Range/slide evidence directly. Call read_document only when a returned coordinate needs expansion. Do not scan whole documents repeatedly, and do not use Python or shell libraries unless these tools return an explicit error or unsupported-feature notice.'
    })
    ctx.tools.register(
      defineSearchDocumentsTool(
        ctx,
        {
          maxFileBytes: config.maxFileBytes,
          maxFiles: config.retrievalMaxFiles,
          maxResults: config.retrievalMaxResults,
          blockChars: config.retrievalBlockChars,
          maxBlocksPerDocument: config.retrievalMaxBlocksPerDocument,
          documentTtlMs: config.retrievalDocumentTtlMs,
          queryLogTtlMs: config.retrievalQueryLogTtlMs,
          timeoutMs: config.retrievalTimeoutMs
        },
        createdBackend
      )
    )
    ctx.on('dispose', () => {
      void createdBackend.then(({ backend }) => backend.close())
    })
  }

  ctx.systemPrompt.section({
    name: 'tool:read-document',
    order: 110,
    text: 'read_document reads PDF/DOCX/XLSX/PPTX/text directly; PPTX slide text and speaker notes are native, so do not use Python or shell libraries for these supported formats unless read_document returns an explicit error or unsupported-feature notice. For XLSX: call list_sheets first, choose a sheet, then use cell_range when only part of the worksheet is needed. Treat detected counts and truncation notices as authoritative boundaries; never describe a partial window as the complete workbook or deck.'
  })

  ctx.tools.register(
    defineReadDocumentTool(
      ctx,
      {
        readLimit: config.readLimit,
        maxFileBytes: config.maxFileBytes,
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets,
        maxOutputChars: config.maxOutputChars,
        readTimeoutMs: config.readTimeoutMs
      },
      cache
    )
  )

  const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads')
  // Uploads normally live under each session cwd, not `uploadDir`. Track every
  // observed workspace root so TTL cleanup covers the real storage locations.
  const uploadRoots = new Set<string>([defaultDir])
  for (const session of ctx.sessions.list()) {
    if (typeof session.header.cwd === 'string') uploadRoots.add(session.header.cwd)
  }
  const sessionCwd = (sessionId: string) => {
    const session = ctx.sessions.get(sessionId)
    return session === undefined ? undefined : session.header.cwd
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/upload',
      handler: createUploadHandler({
        maxBytes: config.uploadMaxBytes,
        allowedExtensions: config.allowedExtensions,
        ttlMs: config.uploadTtlMs,
        sweepIntervalMs: config.sweepIntervalMs,
        maxConcurrent: config.maxConcurrentUploads,
        maxSessionBytes: config.maxUploadBytesPerSession,
        trustedHosts: config.trustedHosts,
        defaultDir,
        onStorageRoot: (root) => uploadRoots.add(root),
        sessionCwd
      })
    })
  )

  const disposeSweeper = createSweeper(() => uploadRoots, config.uploadTtlMs, config.sweepIntervalMs)
  ctx.on('dispose', disposeSweeper)

  // @ 工作区候选端点：只读返回当前会话 cwd 下的相对路径列表。
  // 与上传端点同款网络护栏；client 侧 30s 缓存，索引上限默认 500 文件 / 12 层深。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/workspace-files',
      handler: createWorkspaceFilesHandler({
        sessionCwd,
        trustedHosts: config.trustedHosts,
        indexOptions: {
          ignoredDirs: DEFAULT_IGNORED_DIRS,
          ignoredFiles: DEFAULT_IGNORED_FILES,
          ignoredExtensions: DEFAULT_IGNORED_EXTENSIONS,
          maxDepth: config.workspaceMaxDepth,
          maxFiles: config.workspaceMaxFiles
        }
      })
    })
  )
}
