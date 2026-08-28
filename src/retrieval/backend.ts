import type { DatabaseSync } from 'node:sqlite'
import type { DocumentBlock, DocumentDescriptor } from './blocks.ts'
import { buildQueryPlan, containsTokenPhrase, tokenizeForIndex, type QueryPlan } from './tokenize.ts'

export type RetrievalBackendKind = 'sqlite-fts5' | 'js-memory'

export interface SearchHit {
  documentId: string
  path: string
  format: DocumentDescriptor['format']
  version: string
  coordinate: string
  heading: string
  text: string
  score: number
}

export interface RetrievalBackend {
  readonly kind: RetrievalBackendKind
  documentVersion(documentId: string): string | undefined
  replaceDocument(document: DocumentDescriptor, blocks: DocumentBlock[], now: number): void
  /** Optional streaming-friendly replacement used by the model-facing tool. */
  replaceDocumentCooperatively?(document: DocumentDescriptor, blocks: DocumentBlock[], now: number): Promise<void>
  removeDocument(documentId: string): void
  touchDocuments(documentIds: string[], now: number): void
  search(plan: QueryPlan, documentIds: string[], limit: number): SearchHit[]
  logQuery(query: string, documentIds: string[], resultCount: number, now: number): void
  gc(now: number, documentTtlMs: number, queryLogTtlMs: number): { documents: number; queries: number }
  close(): void
}

interface MemoryDocument {
  descriptor: DocumentDescriptor
  blocks: Array<{
    value: DocumentBlock
    headingTokens: string[]
    textTokens: string[]
    normalizedText: string
  }>
  lastSeenAt: number
}

function countPhrase(tokens: readonly string[], phrase: readonly string[]): number {
  if (phrase.length === 0) return 0
  let count = 0
  outer: for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[start + offset] !== phrase[offset]) continue outer
    }
    count += 1
  }
  return count
}

function normalizedSearchText(block: Pick<DocumentBlock, 'heading' | 'coordinate' | 'text'>): string {
  return `${block.heading}\n${block.coordinate}\n${block.text}`.normalize('NFKC')
}

function supportsRelaxedFallback(plan: QueryPlan): boolean {
  return plan.phrases.length >= 2 || (plan.phrases.length === 1 && plan.phrases[0].length >= 3)
}

/** Dependency-free fallback used when Harness' actual Node runtime lacks FTS5. */
export class MemoryRetrievalBackend implements RetrievalBackend {
  readonly kind = 'js-memory' as const
  private documents = new Map<string, MemoryDocument>()
  // Query values are intentionally retained only for the same bounded TTL as
  // SQLite. This is private process memory and is never emitted to logs.
  private queryLog: Array<{ query: string; documentIds: string[]; resultCount: number; at: number }> = []

  documentVersion(documentId: string): string | undefined {
    return this.documents.get(documentId)?.descriptor.version
  }

  replaceDocument(document: DocumentDescriptor, blocks: DocumentBlock[], now: number): void {
    this.documents.set(document.id, {
      descriptor: document,
      lastSeenAt: now,
      blocks: blocks.map((value) => ({
        value,
        headingTokens: tokenizeForIndex(`${value.heading} ${value.coordinate}`),
        textTokens: tokenizeForIndex(value.text),
        normalizedText: normalizedSearchText(value)
      }))
    })
  }

  async replaceDocumentCooperatively(document: DocumentDescriptor, blocks: DocumentBlock[], now: number): Promise<void> {
    const staged: MemoryDocument['blocks'] = []
    for (let start = 0; start < blocks.length; start += 512) {
      for (const value of blocks.slice(start, start + 512)) {
        staged.push({
          value,
          headingTokens: tokenizeForIndex(`${value.heading} ${value.coordinate}`),
          textTokens: tokenizeForIndex(value.text),
          normalizedText: normalizedSearchText(value)
        })
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    // Publish only after the complete projection is ready; searches never see
    // a half-built in-memory document.
    this.documents.set(document.id, {
      descriptor: document,
      lastSeenAt: now,
      blocks: staged
    })
  }

  removeDocument(documentId: string): void {
    this.documents.delete(documentId)
  }

  touchDocuments(documentIds: string[], now: number): void {
    for (const id of documentIds) {
      const document = this.documents.get(id)
      if (document !== undefined) document.lastSeenAt = now
    }
  }

  search(plan: QueryPlan, documentIds: string[], limit: number): SearchHit[] {
    const collect = (mode: 'strict' | 'relaxed'): SearchHit[] => {
      const hits: SearchHit[] = []
      for (const documentId of documentIds) {
        const document = this.documents.get(documentId)
        if (document === undefined) continue
        for (const block of document.blocks) {
          const phraseMatches = plan.phrases.map((phrase) =>
            containsTokenPhrase(block.headingTokens, phrase) || containsTokenPhrase(block.textTokens, phrase)
          )
          let matchesPhrases: boolean
          if (mode === 'strict') {
            matchesPhrases = phraseMatches.every(Boolean)
          } else if (plan.phrases.length === 1 && plan.phrases[0].length >= 3) {
            const phrase = plan.phrases[0]
            matchesPhrases = phrase.some((token) =>
              block.headingTokens.includes(token) || block.textTokens.includes(token)
            )
          } else {
            matchesPhrases = phraseMatches.some(Boolean)
          }
          if (!matchesPhrases) continue
          if (!plan.singleCharacters.every((char) => block.normalizedText.includes(char))) continue
          let score = 0
          for (const phrase of plan.phrases) {
            score += 4 * countPhrase(block.headingTokens, phrase) + countPhrase(block.textTokens, phrase)
          }
          score += plan.singleCharacters.filter((char) => block.normalizedText.includes(char)).length
          hits.push({
            documentId,
            path: document.descriptor.path,
            format: document.descriptor.format,
            version: document.descriptor.version,
            coordinate: block.value.coordinate,
            heading: block.value.heading,
            text: block.value.text,
            score
          })
        }
      }
      return hits
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.coordinate.localeCompare(right.coordinate))
        .slice(0, limit)
    }
    const strict = collect('strict')
    if (strict.length > 0 || !supportsRelaxedFallback(plan)) return strict
    return collect('relaxed')
  }

  logQuery(query: string, documentIds: string[], resultCount: number, now: number): void {
    this.queryLog.push({ query, documentIds: [...documentIds], resultCount, at: now })
  }

  gc(now: number, documentTtlMs: number, queryLogTtlMs: number): { documents: number; queries: number } {
    let documents = 0
    for (const [id, document] of this.documents) {
      if (document.lastSeenAt < now - documentTtlMs) {
        this.documents.delete(id)
        documents += 1
      }
    }
    const before = this.queryLog.length
    this.queryLog = this.queryLog.filter((entry) => entry.at >= now - queryLogTtlMs)
    return { documents, queries: before - this.queryLog.length }
  }

  close(): void {
    this.documents.clear()
    this.queryLog = []
  }
}

interface SqliteRow {
  [key: string]: unknown
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`invalid SQLite ${label}`)
  return value
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new Error(`invalid SQLite ${label}`)
  return Number(value)
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Persistent private index backed by the SQLite bundled with Harness' Node. */
export class SqliteRetrievalBackend implements RetrievalBackend {
  readonly kind = 'sqlite-fts5' as const
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        format TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        coordinate TEXT NOT NULL,
        heading TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_document_id ON blocks(document_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
        block_id UNINDEXED,
        document_id UNINDEXED,
        heading_tokens,
        text_tokens,
        tokenize = 'unicode61 remove_diacritics 0'
      );
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        document_ids TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS query_log_created_at ON query_log(created_at);
      PRAGMA user_version = 2;
    `)
    const blockColumns = this.db.prepare('PRAGMA table_info(blocks)').all() as Array<{ name?: unknown }>
    if (!blockColumns.some((column) => column.name === 'normalized_text')) {
      // Existing v1 indexes are re-populated by the retrieval schema version
      // bound into each document version. The empty default keeps migration
      // atomic until that first re-index completes.
      this.db.exec("ALTER TABLE blocks ADD COLUMN normalized_text TEXT NOT NULL DEFAULT ''")
    }
  }

  documentVersion(documentId: string): string | undefined {
    const row = this.db.prepare('SELECT version FROM documents WHERE id = ?').get(documentId) as SqliteRow | undefined
    return row === undefined ? undefined : asString(row.version, 'document version')
  }

  replaceDocument(document: DocumentDescriptor, blocks: DocumentBlock[], now: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM blocks_fts WHERE document_id = ?').run(document.id)
      this.db.prepare('DELETE FROM blocks WHERE document_id = ?').run(document.id)
      this.db.prepare(`
        INSERT INTO documents(id, path, format, version, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          format = excluded.format,
          version = excluded.version,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at
      `).run(document.id, document.path, document.format, document.version, now, now)
      const insertBlock = this.db.prepare(`
        INSERT INTO blocks(id, document_id, version, ordinal, coordinate, heading, text, normalized_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFts = this.db.prepare(`
        INSERT INTO blocks_fts(block_id, document_id, heading_tokens, text_tokens)
        VALUES (?, ?, ?, ?)
      `)
      for (const block of blocks) {
        insertBlock.run(
          block.id,
          document.id,
          document.version,
          block.ordinal,
          block.coordinate,
          block.heading,
          block.text,
          normalizedSearchText(block)
        )
        insertFts.run(
          block.id,
          document.id,
          tokenizeForIndex(`${block.heading} ${block.coordinate}`).join(' '),
          tokenizeForIndex(block.text).join(' ')
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Replace a large index in bounded SQLite transactions and yield between
   * them. The document stays on a non-searchable pending version until the
   * final commit, so concurrent calls never observe a partial index and an
   * interrupted build is automatically retried by documentVersion().
   */
  async replaceDocumentCooperatively(
    document: DocumentDescriptor,
    blocks: DocumentBlock[],
    now: number
  ): Promise<void> {
    const pendingVersion = `pending:${document.version}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM blocks_fts WHERE document_id = ?').run(document.id)
      this.db.prepare('DELETE FROM blocks WHERE document_id = ?').run(document.id)
      this.db.prepare(`
        INSERT INTO documents(id, path, format, version, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          format = excluded.format,
          version = excluded.version,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at
      `).run(document.id, document.path, document.format, pendingVersion, now, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const insertBlock = this.db.prepare(`
      INSERT INTO blocks(id, document_id, version, ordinal, coordinate, heading, text, normalized_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.db.prepare(`
      INSERT INTO blocks_fts(block_id, document_id, heading_tokens, text_tokens)
      VALUES (?, ?, ?, ?)
    `)
    const batchSize = 512
    for (let start = 0; start < blocks.length; start += batchSize) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const block of blocks.slice(start, start + batchSize)) {
          insertBlock.run(
            block.id,
            document.id,
            document.version,
            block.ordinal,
            block.coordinate,
            block.heading,
            block.text,
            normalizedSearchText(block)
          )
          insertFts.run(
            block.id,
            document.id,
            tokenizeForIndex(`${block.heading} ${block.coordinate}`).join(' '),
            tokenizeForIndex(block.text).join(' ')
          )
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE documents
        SET version = ?, updated_at = ?, last_seen_at = ?
        WHERE id = ? AND version = ?
      `).run(document.version, now, now, document.id, pendingVersion)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeDocument(documentId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM blocks_fts WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  touchDocuments(documentIds: string[], now: number): void {
    if (documentIds.length === 0) return
    this.db.prepare(`UPDATE documents SET last_seen_at = ? WHERE id IN (${placeholders(documentIds.length)})`)
      .run(now, ...documentIds)
  }

  private ftsCandidates(
    matchExpression: string,
    documentIds: string[],
    candidateLimit: number,
    singleCharacters: string[] = []
  ): SearchHit[] {
    if (matchExpression === '' || documentIds.length === 0) return []
    const characterClauses = singleCharacters.map(() => `b.normalized_text LIKE ? ESCAPE '\\'`)
    const characterValues = singleCharacters.map((char) => `%${escapeLike(char)}%`)
    const sql = `
      SELECT d.id AS document_id, d.path, d.format, d.version,
             b.coordinate, b.heading, b.text,
             bm25(blocks_fts, 0.0, 0.0, 4.0, 1.0) AS raw_score
      FROM blocks_fts
      JOIN blocks b ON b.id = blocks_fts.block_id
      JOIN documents d ON d.id = b.document_id
      WHERE blocks_fts MATCH ?
        AND b.document_id IN (${placeholders(documentIds.length)})
        AND d.version NOT LIKE 'pending:%'
        ${characterClauses.length === 0 ? '' : `AND ${characterClauses.join(' AND ')}`}
      ORDER BY raw_score ASC, b.ordinal ASC
      LIMIT ?
    `
    const rows = this.db.prepare(sql).all(matchExpression, ...documentIds, ...characterValues, candidateLimit) as SqliteRow[]
    return rows.map((row) => ({
      documentId: asString(row.document_id, 'document id'),
      path: asString(row.path, 'path'),
      format: asString(row.format, 'format') as SearchHit['format'],
      version: asString(row.version, 'version'),
      coordinate: asString(row.coordinate, 'coordinate'),
      heading: asString(row.heading, 'heading'),
      text: asString(row.text, 'text'),
      score: Math.max(0, -asNumber(row.raw_score, 'BM25 score'))
    }))
  }

  private singleCharacterCandidates(plan: QueryPlan, documentIds: string[], limit: number): SearchHit[] {
    if (plan.singleCharacters.length === 0 || documentIds.length === 0) return []
    const clauses = plan.singleCharacters.map(() => `b.normalized_text LIKE ? ESCAPE '\\'`)
    const values = plan.singleCharacters.flatMap((char) => {
      const pattern = `%${escapeLike(char)}%`
      return [pattern]
    })
    const sql = `
      SELECT d.id AS document_id, d.path, d.format, d.version,
             b.coordinate, b.heading, b.text, b.ordinal
      FROM blocks b
      JOIN documents d ON d.id = b.document_id
      WHERE b.document_id IN (${placeholders(documentIds.length)})
        AND d.version NOT LIKE 'pending:%'
        AND ${clauses.join(' AND ')}
      ORDER BY b.ordinal ASC
      LIMIT ?
    `
    const rows = this.db.prepare(sql).all(...documentIds, ...values, limit) as SqliteRow[]
    return rows.map((row) => ({
      documentId: asString(row.document_id, 'document id'),
      path: asString(row.path, 'path'),
      format: asString(row.format, 'format') as SearchHit['format'],
      version: asString(row.version, 'version'),
      coordinate: asString(row.coordinate, 'coordinate'),
      heading: asString(row.heading, 'heading'),
      text: asString(row.text, 'text'),
      score: plan.singleCharacters.length
    }))
  }

  search(plan: QueryPlan, documentIds: string[], limit: number): SearchHit[] {
    const candidateLimit = Math.min(Math.max(limit * 32, 200), 2_000)
    let candidates = plan.ftsQuery === ''
      ? this.singleCharacterCandidates(plan, documentIds, candidateLimit)
      : this.ftsCandidates(plan.ftsQuery, documentIds, candidateLimit, plan.singleCharacters)
    if (candidates.length === 0 && supportsRelaxedFallback(plan)) {
      candidates = this.ftsCandidates(plan.relaxedFtsQuery, documentIds, candidateLimit, plan.singleCharacters)
    }
    return candidates.slice(0, limit)
  }

  logQuery(query: string, documentIds: string[], resultCount: number, now: number): void {
    this.db.prepare(`
      INSERT INTO query_log(query, document_ids, result_count, created_at)
      VALUES (?, ?, ?, ?)
    `).run(query, JSON.stringify(documentIds), resultCount, now)
  }

  gc(now: number, documentTtlMs: number, queryLogTtlMs: number): { documents: number; queries: number } {
    const stale = this.db.prepare('SELECT id FROM documents WHERE last_seen_at < ?')
      .all(now - documentTtlMs) as SqliteRow[]
    for (const row of stale) this.removeDocument(asString(row.id, 'document id'))
    const queryResult = this.db.prepare('DELETE FROM query_log WHERE created_at < ?').run(now - queryLogTtlMs)
    return { documents: stale.length, queries: Number(queryResult.changes) }
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }
}

/** Convenience entry used in focused tests and callers that already have a backend. */
export function searchBackend(backend: RetrievalBackend, query: string, documentIds: string[], limit: number): SearchHit[] {
  return backend.search(buildQueryPlan(query), documentIds, limit)
}
