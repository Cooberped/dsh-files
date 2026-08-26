import { buildQueryPlan, containsTokenPhrase, tokenizeForIndex } from "./tokenize.js";
function countPhrase(tokens, phrase) {
    if (phrase.length === 0)
        return 0;
    let count = 0;
    outer: for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
        for (let offset = 0; offset < phrase.length; offset += 1) {
            if (tokens[start + offset] !== phrase[offset])
                continue outer;
        }
        count += 1;
    }
    return count;
}
/** Dependency-free fallback used when Harness' actual Node runtime lacks FTS5. */
export class MemoryRetrievalBackend {
    kind = 'js-memory';
    documents = new Map();
    // Query values are intentionally retained only for the same bounded TTL as
    // SQLite. This is private process memory and is never emitted to logs.
    queryLog = [];
    documentVersion(documentId) {
        return this.documents.get(documentId)?.descriptor.version;
    }
    replaceDocument(document, blocks, now) {
        this.documents.set(document.id, {
            descriptor: document,
            lastSeenAt: now,
            blocks: blocks.map((value) => ({
                value,
                headingTokens: tokenizeForIndex(`${value.heading} ${value.coordinate}`),
                textTokens: tokenizeForIndex(value.text),
                normalizedText: `${value.heading}\n${value.coordinate}\n${value.text}`.normalize('NFKC')
            }))
        });
    }
    removeDocument(documentId) {
        this.documents.delete(documentId);
    }
    touchDocuments(documentIds, now) {
        for (const id of documentIds) {
            const document = this.documents.get(id);
            if (document !== undefined)
                document.lastSeenAt = now;
        }
    }
    search(plan, documentIds, limit) {
        const collect = (requireAllPhrases) => {
            const hits = [];
            for (const documentId of documentIds) {
                const document = this.documents.get(documentId);
                if (document === undefined)
                    continue;
                for (const block of document.blocks) {
                    const phraseMatches = plan.phrases.map((phrase) => containsTokenPhrase(block.headingTokens, phrase) || containsTokenPhrase(block.textTokens, phrase));
                    const matchesPhrases = requireAllPhrases ? phraseMatches.every(Boolean) : phraseMatches.some(Boolean);
                    if (!matchesPhrases)
                        continue;
                    if (!plan.singleCharacters.every((char) => block.normalizedText.includes(char)))
                        continue;
                    let score = 0;
                    for (const phrase of plan.phrases) {
                        score += 4 * countPhrase(block.headingTokens, phrase) + countPhrase(block.textTokens, phrase);
                    }
                    score += plan.singleCharacters.filter((char) => block.normalizedText.includes(char)).length;
                    hits.push({
                        documentId,
                        path: document.descriptor.path,
                        format: document.descriptor.format,
                        version: document.descriptor.version,
                        coordinate: block.value.coordinate,
                        heading: block.value.heading,
                        text: block.value.text,
                        score
                    });
                }
            }
            return hits
                .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.coordinate.localeCompare(right.coordinate))
                .slice(0, limit);
        };
        const strict = collect(true);
        if (strict.length > 0 || plan.phrases.length < 2)
            return strict;
        return collect(false);
    }
    logQuery(query, documentIds, resultCount, now) {
        this.queryLog.push({ query, documentIds: [...documentIds], resultCount, at: now });
    }
    gc(now, documentTtlMs, queryLogTtlMs) {
        let documents = 0;
        for (const [id, document] of this.documents) {
            if (document.lastSeenAt < now - documentTtlMs) {
                this.documents.delete(id);
                documents += 1;
            }
        }
        const before = this.queryLog.length;
        this.queryLog = this.queryLog.filter((entry) => entry.at >= now - queryLogTtlMs);
        return { documents, queries: before - this.queryLog.length };
    }
    close() {
        this.documents.clear();
        this.queryLog = [];
    }
}
function asString(value, label) {
    if (typeof value !== 'string')
        throw new Error(`invalid SQLite ${label}`);
    return value;
}
function asNumber(value, label) {
    if (typeof value !== 'number' && typeof value !== 'bigint')
        throw new Error(`invalid SQLite ${label}`);
    return Number(value);
}
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
/** Persistent private index backed by the SQLite bundled with Harness' Node. */
export class SqliteRetrievalBackend {
    kind = 'sqlite-fts5';
    db;
    constructor(db) {
        this.db = db;
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
        text TEXT NOT NULL
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
      PRAGMA user_version = 1;
    `);
    }
    documentVersion(documentId) {
        const row = this.db.prepare('SELECT version FROM documents WHERE id = ?').get(documentId);
        return row === undefined ? undefined : asString(row.version, 'document version');
    }
    replaceDocument(document, blocks, now) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM blocks_fts WHERE document_id = ?').run(document.id);
            this.db.prepare('DELETE FROM blocks WHERE document_id = ?').run(document.id);
            this.db.prepare(`
        INSERT INTO documents(id, path, format, version, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          format = excluded.format,
          version = excluded.version,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at
      `).run(document.id, document.path, document.format, document.version, now, now);
            const insertBlock = this.db.prepare(`
        INSERT INTO blocks(id, document_id, version, ordinal, coordinate, heading, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            const insertFts = this.db.prepare(`
        INSERT INTO blocks_fts(block_id, document_id, heading_tokens, text_tokens)
        VALUES (?, ?, ?, ?)
      `);
            for (const block of blocks) {
                insertBlock.run(block.id, document.id, document.version, block.ordinal, block.coordinate, block.heading, block.text);
                insertFts.run(block.id, document.id, tokenizeForIndex(`${block.heading} ${block.coordinate}`).join(' '), tokenizeForIndex(block.text).join(' '));
            }
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    removeDocument(documentId) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM blocks_fts WHERE document_id = ?').run(documentId);
            this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    touchDocuments(documentIds, now) {
        if (documentIds.length === 0)
            return;
        this.db.prepare(`UPDATE documents SET last_seen_at = ? WHERE id IN (${placeholders(documentIds.length)})`)
            .run(now, ...documentIds);
    }
    ftsCandidates(matchExpression, documentIds, candidateLimit) {
        if (matchExpression === '' || documentIds.length === 0)
            return [];
        const sql = `
      SELECT d.id AS document_id, d.path, d.format, d.version,
             b.coordinate, b.heading, b.text,
             bm25(blocks_fts, 0.0, 0.0, 4.0, 1.0) AS raw_score
      FROM blocks_fts
      JOIN blocks b ON b.id = blocks_fts.block_id
      JOIN documents d ON d.id = b.document_id
      WHERE blocks_fts MATCH ?
        AND b.document_id IN (${placeholders(documentIds.length)})
      ORDER BY raw_score ASC, b.ordinal ASC
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(matchExpression, ...documentIds, candidateLimit);
        return rows.map((row) => ({
            documentId: asString(row.document_id, 'document id'),
            path: asString(row.path, 'path'),
            format: asString(row.format, 'format'),
            version: asString(row.version, 'version'),
            coordinate: asString(row.coordinate, 'coordinate'),
            heading: asString(row.heading, 'heading'),
            text: asString(row.text, 'text'),
            score: Math.max(0, -asNumber(row.raw_score, 'BM25 score'))
        }));
    }
    singleCharacterCandidates(plan, documentIds, limit) {
        if (plan.singleCharacters.length === 0 || documentIds.length === 0)
            return [];
        const clauses = plan.singleCharacters.map(() => `(
      b.heading LIKE ? ESCAPE '\\' OR b.coordinate LIKE ? ESCAPE '\\' OR b.text LIKE ? ESCAPE '\\'
    )`);
        const values = plan.singleCharacters.flatMap((char) => {
            const pattern = `%${escapeLike(char)}%`;
            return [pattern, pattern, pattern];
        });
        const sql = `
      SELECT d.id AS document_id, d.path, d.format, d.version,
             b.coordinate, b.heading, b.text, b.ordinal
      FROM blocks b
      JOIN documents d ON d.id = b.document_id
      WHERE b.document_id IN (${placeholders(documentIds.length)})
        AND ${clauses.join(' AND ')}
      ORDER BY b.ordinal ASC
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(...documentIds, ...values, limit);
        return rows.map((row) => ({
            documentId: asString(row.document_id, 'document id'),
            path: asString(row.path, 'path'),
            format: asString(row.format, 'format'),
            version: asString(row.version, 'version'),
            coordinate: asString(row.coordinate, 'coordinate'),
            heading: asString(row.heading, 'heading'),
            text: asString(row.text, 'text'),
            score: plan.singleCharacters.length
        }));
    }
    search(plan, documentIds, limit) {
        const candidateLimit = Math.min(Math.max(limit * 32, 200), 2_000);
        let candidates = plan.ftsQuery === ''
            ? this.singleCharacterCandidates(plan, documentIds, candidateLimit)
            : this.ftsCandidates(plan.ftsQuery, documentIds, candidateLimit);
        if (plan.ftsQuery !== '' && plan.singleCharacters.length > 0) {
            candidates = candidates.filter((hit) => {
                const value = `${hit.heading}\n${hit.coordinate}\n${hit.text}`.normalize('NFKC');
                return plan.singleCharacters.every((char) => value.includes(char));
            });
        }
        if (candidates.length === 0 && plan.phrases.length >= 2) {
            candidates = this.ftsCandidates(plan.relaxedFtsQuery, documentIds, candidateLimit);
            if (plan.singleCharacters.length > 0) {
                candidates = candidates.filter((hit) => {
                    const value = `${hit.heading}\n${hit.coordinate}\n${hit.text}`.normalize('NFKC');
                    return plan.singleCharacters.every((char) => value.includes(char));
                });
            }
        }
        return candidates.slice(0, limit);
    }
    logQuery(query, documentIds, resultCount, now) {
        this.db.prepare(`
      INSERT INTO query_log(query, document_ids, result_count, created_at)
      VALUES (?, ?, ?, ?)
    `).run(query, JSON.stringify(documentIds), resultCount, now);
    }
    gc(now, documentTtlMs, queryLogTtlMs) {
        const stale = this.db.prepare('SELECT id FROM documents WHERE last_seen_at < ?')
            .all(now - documentTtlMs);
        for (const row of stale)
            this.removeDocument(asString(row.id, 'document id'));
        const queryResult = this.db.prepare('DELETE FROM query_log WHERE created_at < ?').run(now - queryLogTtlMs);
        return { documents: stale.length, queries: Number(queryResult.changes) };
    }
    close() {
        if (this.db.isOpen)
            this.db.close();
    }
}
/** Convenience entry used in focused tests and callers that already have a backend. */
export function searchBackend(backend, query, documentIds, limit) {
    return backend.search(buildQueryPlan(query), documentIds, limit);
}
