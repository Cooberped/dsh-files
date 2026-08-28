import { chmod, mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { MemoryRetrievalBackend, SqliteRetrievalBackend, type RetrievalBackend, type RetrievalBackendKind } from './backend.ts'

export interface RetrievalRuntimeReport {
  nodeVersion: string
  backend: RetrievalBackendKind
  sqliteVersion?: string
  compileOptionFts5?: boolean
  phraseProbe: boolean
  fallbackReason?: string
}

export interface RetrievalLogger {
  info(format: unknown, ...args: unknown[]): void
  warn(format: unknown, ...args: unknown[]): void
}

export type SqliteLoader = () => Promise<{ DatabaseSync: typeof DatabaseSync }>

interface InternalProbe {
  report: RetrievalRuntimeReport
  sqlite?: { DatabaseSync: typeof DatabaseSync }
  /** Raw diagnostic is retained only for the internal logger, never tools. */
  internalFallbackReason?: string
}

function safeReason(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return value.replace(/[\r\n]+/g, ' ').slice(0, 240)
}

function errorCategory(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code
  const message = error instanceof Error ? error.message : ''
  if (message === 'FTS5 ordered bigram phrase probe failed') return 'FTS5_PHRASE_PROBE_FAILED'
  if (message.includes('expected mode 0700')) return 'INDEX_DIRECTORY_PERMISSIONS'
  if (message === 'retrieval index path is not a directory') return 'INDEX_DIRECTORY_TYPE'
  if (error instanceof TypeError) return 'TYPE_ERROR'
  return 'UNKNOWN_ERROR'
}

/** Stable, actionable, model-safe fallback reason: never embeds error text or host paths. */
function modelSafeFallbackReason(error: unknown, scope: 'runtime' | 'persistent-index'): string {
  const category = errorCategory(error)
  if (scope === 'runtime') {
    return `SQLite runtime unavailable [${category}]; using the non-persistent memory index. Verify the Harness runtime provides node:sqlite with FTS5 phrase-search support.`
  }
  return `Persistent SQLite index unavailable [${category}]; using the non-persistent memory index. Check that the configured index parent is writable and the private index directory uses mode 0700.`
}

async function internalProbe(loadSqlite: SqliteLoader): Promise<InternalProbe> {
  const nodeVersion = process.versions.node
  let sqlite: { DatabaseSync: typeof DatabaseSync } | undefined
  try {
    sqlite = await loadSqlite()
    const db = new sqlite.DatabaseSync(':memory:')
    try {
      const versionRow = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined
      const sqliteVersion = typeof versionRow?.version === 'string' ? versionRow.version : 'unknown'
      const compileRows = db.prepare('PRAGMA compile_options').all() as Array<{ compile_options?: unknown }>
      const compileOptionFts5 = compileRows.some((row) => row.compile_options === 'ENABLE_FTS5')
      db.exec(`
        CREATE VIRTUAL TABLE retrieval_probe USING fts5(body, tokenize = 'unicode61 remove_diacritics 0');
        INSERT INTO retrieval_probe(body) VALUES ('流程 程绩 绩效');
      `)
      const ordered = db.prepare('SELECT rowid FROM retrieval_probe WHERE retrieval_probe MATCH ?')
        .get('"流程 程绩 绩效"')
      const reversed = db.prepare('SELECT rowid FROM retrieval_probe WHERE retrieval_probe MATCH ?')
        .get('"绩效 效流 流程"')
      if (ordered === undefined || reversed !== undefined) throw new Error('FTS5 ordered bigram phrase probe failed')
      return {
        sqlite,
        report: {
          nodeVersion,
          backend: 'sqlite-fts5',
          sqliteVersion,
          compileOptionFts5,
          phraseProbe: true
        }
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      internalFallbackReason: safeReason(error),
      report: {
        nodeVersion,
        backend: 'js-memory',
        phraseProbe: false,
        fallbackReason: modelSafeFallbackReason(error, 'runtime')
      }
    }
  }
}

/** Probe the actual Harness runtime, not whichever `node` happens to be in PATH. */
export async function probeRetrievalRuntime(
  loadSqlite: SqliteLoader = () => import('node:sqlite')
): Promise<RetrievalRuntimeReport> {
  return (await internalProbe(loadSqlite)).report
}

async function secureIndexDirectory(indexDir: string): Promise<void> {
  await mkdir(indexDir, { recursive: true, mode: 0o700 })
  const info = await stat(indexDir)
  if (!info.isDirectory()) throw new Error('retrieval index path is not a directory')
  // Do not chmod an arbitrary configured directory: `/tmp` or a workspace
  // root would be a dangerous target. A pre-existing shared directory fails
  // to the memory backend; a dedicated private directory is required.
  if ((info.mode & 0o077) !== 0) {
    throw new Error('retrieval index directory must not grant group or other permissions (expected mode 0700)')
  }
}

async function secureSqliteCompanions(dbPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    try {
      await chmod(`${dbPath}${suffix}`, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export interface CreateRetrievalBackendOptions {
  indexDir: string
  logger: RetrievalLogger
  loadSqlite?: SqliteLoader
}

export interface CreatedRetrievalBackend {
  backend: RetrievalBackend
  report: RetrievalRuntimeReport
}

/** Create the persistent index when possible, otherwise fail open to JS memory. */
export async function createRetrievalBackend(
  options: CreateRetrievalBackendOptions
): Promise<CreatedRetrievalBackend> {
  const probe = await internalProbe(options.loadSqlite ?? (() => import('node:sqlite')))
  let backend: RetrievalBackend
  let report = probe.report
  let internalFallbackReason = probe.internalFallbackReason
  if (probe.sqlite !== undefined && probe.report.backend === 'sqlite-fts5') {
    let database: DatabaseSync | undefined
    try {
      await secureIndexDirectory(options.indexDir)
      const dbPath = join(options.indexDir, 'retrieval.sqlite3')
      // Create the main file with its final mode before SQLite opens it. WAL
      // companions remain protected by the parent directory's 0700 boundary.
      const handle = await open(dbPath, 'a', 0o600)
      await handle.close()
      await chmod(dbPath, 0o600)
      database = new probe.sqlite.DatabaseSync(dbPath)
      backend = new SqliteRetrievalBackend(database)
      await chmod(dbPath, 0o600)
      await secureSqliteCompanions(dbPath)
    } catch (error) {
      if (database?.isOpen === true) database.close()
      internalFallbackReason = safeReason(error)
      report = {
        ...probe.report,
        backend: 'js-memory',
        fallbackReason: modelSafeFallbackReason(error, 'persistent-index')
      }
      backend = new MemoryRetrievalBackend()
    }
  } else {
    backend = new MemoryRetrievalBackend()
  }

  options.logger.info(
    'retrieval self-check: node=%s backend=%s sqlite=%s compileOptionFts5=%s phraseProbe=%s',
    report.nodeVersion,
    report.backend,
    report.sqliteVersion ?? 'unavailable',
    report.compileOptionFts5 ?? false,
    report.phraseProbe
  )
  if (report.fallbackReason !== undefined) {
    options.logger.warn('retrieval fallback active: %s', report.fallbackReason)
  }
  if (internalFallbackReason !== undefined) {
    options.logger.warn('retrieval fallback internal detail: %s', internalFallbackReason)
  }
  return { backend, report }
}
