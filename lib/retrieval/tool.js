import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { formatFromExtension, HEAD_SNIFF_BYTES, sniffFormat, sniffHead } from "../detect.js";
import { buildDocumentBlocks } from "./blocks.js";
import { buildQueryPlan } from "./tokenize.js";
function parseArgs(args, config) {
    if (!Array.isArray(args.file_paths) || args.file_paths.length === 0) {
        throw new Error('file_paths must be a non-empty array of document paths');
    }
    if (args.file_paths.length > config.maxFiles) {
        throw new Error(`file_paths must contain at most ${config.maxFiles} documents`);
    }
    const filePaths = [];
    const seen = new Set();
    for (const value of args.file_paths) {
        if (typeof value !== 'string' || value.trim() === '')
            throw new Error('every file_paths item must be a non-empty string');
        const path = value.trim().normalize('NFC');
        if (!seen.has(path)) {
            seen.add(path);
            filePaths.push(path);
        }
    }
    let query;
    if (args.query !== undefined) {
        if (typeof args.query !== 'string')
            throw new Error('query must be a string when provided');
        const candidate = args.query.trim().normalize('NFC');
        if (candidate !== '') {
            const plan = buildQueryPlan(candidate);
            if (plan.phrases.length === 0 && plan.singleCharacters.length === 0) {
                throw new Error('query must contain at least one letter, number, or CJK character');
            }
            query = candidate;
        }
    }
    const limit = args.limit === undefined ? config.maxResults : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > config.maxResults) {
        throw new Error(`limit must be an integer from 1 to ${config.maxResults}`);
    }
    return { filePaths, query, limit };
}
function hashBytes(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex');
}
function sessionCwd(exec) {
    return exec.agent?.session?.header?.cwd;
}
function detectedFormat(bytes, path) {
    const head = bytes.subarray(0, Math.min(HEAD_SNIFF_BYTES, bytes.length));
    const headFormat = sniffHead(head);
    if (headFormat === 'zip' || headFormat === null) {
        return sniffFormat(bytes, formatFromExtension(path) ?? undefined);
    }
    return headFormat;
}
async function readSource(ctx, path, cwd, config, exec, sourceCache) {
    const target = await ctx.fs.resolve(path, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
        throw new FsError(`cannot index "${target.displayPath}": not found`, 'FS_NOT_FOUND');
    }
    if (info.type !== 'file')
        throw new FsError(`cannot index "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
    if (info.size !== undefined && info.size > config.maxFileBytes) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        throw new FsError(`cannot index "${target.displayPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`, 'FS_TOO_LARGE');
    }
    const targetKey = String(target.targetKey);
    const fsVersion = String(info.version);
    const cached = sourceCache.get(targetKey);
    if (cached?.fsVersion === fsVersion) {
        const descriptor = {
            ...cached.descriptor,
            path: target.displayPath.normalize('NFC')
        };
        // Refresh insertion order so the bounded map behaves as a small LRU.
        sourceCache.delete(targetKey);
        sourceCache.set(targetKey, { fsVersion, descriptor });
        return { target, version: info.version, descriptor };
    }
    const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes);
    const format = detectedFormat(bytes, path);
    if (format === null) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        throw new FsError(`cannot index "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX or XLSX)`, 'FS_NOT_TEXT');
    }
    const descriptor = {
        id: hashBytes(targetKey),
        path: target.displayPath.normalize('NFC'),
        format,
        version: hashBytes(bytes)
    };
    sourceCache.delete(targetKey);
    sourceCache.set(targetKey, { fsVersion, descriptor });
    while (sourceCache.size > 256) {
        const oldest = sourceCache.keys().next().value;
        if (oldest === undefined)
            break;
        sourceCache.delete(oldest);
    }
    return {
        target,
        version: info.version,
        bytes,
        descriptor
    };
}
async function bytesForIndex(ctx, source, config, signal) {
    const bytes = source.bytes ?? await ctx.fs.readBytes(source.target, signal, config.maxFileBytes);
    if (hashBytes(bytes) !== source.descriptor.version) {
        throw new Error(`cannot index "${source.target.displayPath}": file changed while it was being indexed; retry the search`);
    }
    return bytes;
}
function renderResults(value) {
    if (value.mode === 'index') {
        const header = `### document index — ${value.documents.length} document(s); backend ${value.backend}; newly indexed ${value.indexedDocuments}`;
        const documents = value.documents.map((document, index) => `${index + 1}. ${document.path} (${document.format}) [version ${document.version.slice(0, 12)}]`);
        return [
            header,
            ...documents,
            'Index ready. No document body text was returned; use search_documents with a short query when the user asks a concrete question.'
        ].join('\n');
    }
    const header = `### document search — ${value.results.length} result(s); backend ${value.backend}; query ${JSON.stringify(value.query)}`;
    if (value.results.length === 0)
        return `${header}\nNo matching evidence found in the selected documents.`;
    const parts = value.results.map((result, index) => [
        `${index + 1}. ${result.path} (${result.format}) @ ${result.coordinate} [version ${result.version.slice(0, 12)}]`,
        result.heading,
        result.text
    ].filter((entry, entryIndex) => entryIndex === 0 || entry.trim() !== '').join('\n'));
    return [header, ...parts].join('\n\n');
}
/** Model-facing local retrieval tool. Parsing remains delegated to src/parse/*. */
export function defineSearchDocumentsTool(ctx, config, createdBackend) {
    const indexing = new Map();
    const sourceCache = new Map();
    let lastGcAt = 0;
    return defineTool({
        name: 'search_documents',
        description: 'Index or search selected PDF/DOCX/XLSX/text files locally before reading long documents. Omit query when the user asks to first read, understand or prepare files without a concrete question: this builds the private index and returns only a compact inventory, not document body text. For a concrete question, pass a short keyword or exact phrase (omit question filler) to receive versioned page/line/Sheet!Range evidence. Use read_document only to expand a returned coordinate; do not use Python or Bash for supported files.',
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
                    indexedDocuments: { type: 'integer', required: true },
                    documents: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'text'] },
                                version: { type: 'string', required: true }
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
                                format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'text'] },
                                version: { type: 'string', required: true },
                                coordinate: { type: 'string', required: true },
                                heading: { type: 'string', required: true },
                                text: { type: 'string', required: true },
                                score: { type: 'number', required: true }
                            }
                        }
                    }
                }
            },
            render: (_args, value) => [{ type: 'text', text: renderResults(value) }],
            presentationMeta: (_args, value) => value
        },
        isConcurrencySafe: () => true,
        timeoutMs: config.timeoutMs,
        async execute(args, exec) {
            const input = parseArgs(args, config);
            const cwd = sessionCwd(exec);
            const { backend } = await createdBackend;
            const sources = [];
            let indexedDocuments = 0;
            for (const path of input.filePaths) {
                const source = await readSource(ctx, path, cwd, config, exec, sourceCache);
                sources.push(source);
                while (backend.documentVersion(source.descriptor.id) !== source.descriptor.version) {
                    const pending = indexing.get(source.descriptor.id);
                    if (pending !== undefined) {
                        await pending;
                        exec.signal.throwIfAborted();
                        continue;
                    }
                    const task = (async () => {
                        const bytes = await bytesForIndex(ctx, source, config, exec.signal);
                        const blocks = await buildDocumentBlocks(bytes, source.descriptor, {
                            blockChars: config.blockChars,
                            maxBlocks: config.maxBlocksPerDocument,
                            signal: exec.signal
                        });
                        backend.replaceDocument(source.descriptor, blocks, Date.now());
                    })();
                    indexing.set(source.descriptor.id, task);
                    indexedDocuments += 1;
                    try {
                        await task;
                    }
                    finally {
                        if (indexing.get(source.descriptor.id) === task)
                            indexing.delete(source.descriptor.id);
                    }
                }
                ctx.emit('fs/observed', source.target, { kind: 'present', version: source.version }, exec);
            }
            const now = Date.now();
            const documentIds = [...new Set(sources.map((source) => source.descriptor.id))];
            backend.touchDocuments(documentIds, now);
            if (now - lastGcAt >= 60 * 60 * 1000) {
                backend.gc(now, config.documentTtlMs, config.queryLogTtlMs);
                lastGcAt = now;
            }
            const documents = sources.map((source) => source.descriptor);
            if (input.query === undefined) {
                return {
                    mode: 'index',
                    query: '',
                    backend: backend.kind,
                    indexedDocuments,
                    documents,
                    results: []
                };
            }
            const plan = buildQueryPlan(input.query);
            const results = backend.search(plan, documentIds, input.limit);
            backend.logQuery(plan.normalizedQuery, documentIds, results.length, now);
            return {
                mode: 'search',
                query: plan.normalizedQuery,
                backend: backend.kind,
                indexedDocuments,
                documents,
                results: results.map(({ documentId: _documentId, ...result }) => result)
            };
        },
        presentCall(args) {
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            return {
                card: 'generic',
                title: query === '' ? 'Index documents' : `Search documents: ${query}`,
                kind: 'read',
                locations: args.file_paths.map((path) => ({ path }))
            };
        },
        presentResult(_args, result) {
            if (result.isError)
                return undefined;
            const value = result.meta;
            if (value === undefined)
                return undefined;
            return {
                card: 'generic',
                title: value.mode === 'index'
                    ? `Document index (${value.documents.length})`
                    : `Document search (${value.results.length})`,
                content: [{ type: 'text', text: renderResults(value) }]
            };
        }
    });
}
