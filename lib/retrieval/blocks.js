// Parser-output -> retrieval block projection. This layer intentionally treats
// src/parse/* as a stable black box: retrieval can be A/B tested independently
// before any parser or richer block-IR redesign is considered.
import { createHash } from 'node:crypto';
import { parseDocument } from "../parse/index.js";
import { splitPdfPages } from "../parse/pdf.js";
import { parseXlsxWorkbook, projectXlsx } from "../parse/xlsx.js";
/**
 * Bump whenever parser output or block/coordinate semantics change. Binding
 * this to the content digest forces a persistent backend to rebuild old
 * projections instead of serving coordinates produced by obsolete rules.
 */
export const RETRIEVAL_SCHEMA_VERSION = 'retrieval-v2';
export function retrievalDocumentVersion(bytes, schemaVersion = RETRIEVAL_SCHEMA_VERSION) {
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(schemaVersion)) {
        throw new Error(`invalid retrieval schema version ${JSON.stringify(schemaVersion)}`);
    }
    return `${schemaVersion}:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`;
}
export const INDEX_TRUNCATION_MARKER = 'dshfilesindextruncated';
const buildMetadata = new WeakMap();
export function documentBlockBuildMetadata(blocks) {
    return buildMetadata.get(blocks) ?? {
        truncated: false,
        maxBlocks: blocks.length,
        sheetIndexes: new Map()
    };
}
function positiveRange(start, end) {
    const startLine = Number(start);
    const endLine = Number(end);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine)
        return null;
    return { startLine, endLine };
}
/** Parse the stable coordinate grammar emitted by retrieval blocks. */
export function parseDocumentLocator(coordinate, sheetIndexes) {
    const page = /^page:(\d+)(?:,lines:(\d+)-(\d+))?$/u.exec(coordinate);
    if (page !== null) {
        const pageNumber = Number(page[1]);
        if (!Number.isInteger(pageNumber) || pageNumber < 1)
            return null;
        const range = page[2] === undefined ? null : positiveRange(page[2], page[3]);
        if (page[2] !== undefined && range === null)
            return null;
        return { kind: 'page', page: pageNumber, ...(range ?? {}) };
    }
    const slide = /^slide:(\d+)(?:,lines:(\d+)-(\d+))?$/u.exec(coordinate);
    if (slide !== null) {
        const slideNumber = Number(slide[1]);
        if (!Number.isInteger(slideNumber) || slideNumber < 1)
            return null;
        const range = slide[2] === undefined ? null : positiveRange(slide[2], slide[3]);
        if (slide[2] !== undefined && range === null)
            return null;
        return { kind: 'slide', slide: slideNumber, ...(range ?? {}) };
    }
    const oneLine = /^line:(\d+)$/u.exec(coordinate);
    if (oneLine !== null) {
        const line = Number(oneLine[1]);
        return Number.isInteger(line) && line >= 1 ? { kind: 'line', startLine: line, endLine: line } : null;
    }
    const lines = /^lines:(\d+)-(\d+)$/u.exec(coordinate);
    if (lines !== null) {
        const range = positiveRange(lines[1], lines[2]);
        return range === null ? null : { kind: 'line', ...range };
    }
    const partMatch = /,part:(\d+)$/u.exec(coordinate);
    const cellCoordinate = partMatch === null ? coordinate : coordinate.slice(0, partMatch.index);
    const quoted = /^'((?:[^']|'')+)'!([A-Z]{1,3}\d+:[A-Z]{1,3}\d+)$/u.exec(cellCoordinate);
    const plain = quoted === null ? /^([^!'\r\n]+)!([A-Z]{1,3}\d+:[A-Z]{1,3}\d+)$/u.exec(cellCoordinate) : null;
    const match = quoted ?? plain;
    if (match !== null) {
        const sheet = (quoted === null ? match[1] : match[1].replace(/''/g, "'")).normalize('NFC');
        const part = partMatch === null ? undefined : Number(partMatch[1]);
        const sheetIndex = sheetIndexes?.get(sheet);
        if (part !== undefined && (!Number.isInteger(part) || part < 1))
            return null;
        return {
            kind: 'sheet',
            sheet,
            ...(sheetIndex === undefined ? {} : { sheetIndex }),
            cellRange: match[2],
            ...(part === undefined ? {} : { part })
        };
    }
    return null;
}
/** Excel-compatible sheet reference; quote unsafe names and escape apostrophes. */
export function formatWorksheetName(name) {
    const normalized = name.normalize('NFC');
    if (/[\r\n]/u.test(normalized)) {
        throw new Error(`cannot index XLSX: worksheet name ${JSON.stringify(normalized)} contains a line break`);
    }
    return /^[\p{L}\p{M}\p{N}_]+$/u.test(normalized)
        ? normalized
        : `'${normalized.replace(/'/g, "''")}'`;
}
function checkAborted(signal) {
    if (signal?.aborted === true)
        throw signal.reason ?? new Error('document indexing aborted');
}
function blockId(document, coordinate, ordinal, text) {
    return createHash('sha256')
        .update(document.id)
        .update('\0')
        .update(document.version)
        .update('\0')
        .update(coordinate)
        .update('\0')
        .update(String(ordinal))
        .update('\0')
        .update(text)
        .digest('hex');
}
function headingFromLines(lines, fallback) {
    const value = lines.find((line) => line.trim() !== '')?.trim() ?? fallback;
    return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}
function splitLongLine(line, maxChars) {
    const chars = Array.from(line);
    if (chars.length <= maxChars)
        return [line];
    const output = [];
    for (let offset = 0; offset < chars.length; offset += maxChars) {
        output.push(chars.slice(offset, offset + maxChars).join(''));
    }
    return output;
}
const COOPERATIVE_YIELD_INTERVAL = 128;
async function yieldToEventLoop(signal) {
    await new Promise((resolve) => setImmediate(resolve));
    checkAborted(signal);
}
async function chunkLines(value, maxChars, signal) {
    const source = value.split(/\r?\n/u);
    const output = [];
    let current = [];
    let size = 0;
    let operations = 0;
    const flush = () => {
        if (current.length === 0)
            return;
        output.push({
            startLine: current[0].line,
            endLine: current.at(-1).line,
            text: current.map((entry) => entry.value).join('\n').trim()
        });
        current = [];
        size = 0;
    };
    for (const [index, line] of source.entries()) {
        for (const part of splitLongLine(line, maxChars)) {
            const entry = { line: index + 1, value: part };
            const added = entry.value.length + (current.length > 0 ? 1 : 0);
            if (current.length > 0 && size + added > maxChars)
                flush();
            current.push(entry);
            size += entry.value.length + (current.length > 1 ? 1 : 0);
            operations += 1;
            if (operations % COOPERATIVE_YIELD_INTERVAL === 0)
                await yieldToEventLoop(signal);
        }
    }
    flush();
    return output.filter((entry) => entry.text !== '');
}
function appendBlock(state, document, coordinate, heading, text, maxBlocks) {
    if (state.output.length >= maxBlocks) {
        state.truncated = true;
        return false;
    }
    const ordinal = state.output.length + 1;
    state.output.push({
        id: blockId(document, coordinate, ordinal, text),
        documentId: document.id,
        version: document.version,
        ordinal,
        coordinate,
        heading,
        text
    });
    state.appendedSinceYield += 1;
    return true;
}
async function maybeYieldAfterBlock(state, signal) {
    if (state.appendedSinceYield < COOPERATIVE_YIELD_INTERVAL)
        return;
    state.appendedSinceYield = 0;
    await yieldToEventLoop(signal);
}
async function genericBlocks(text, document, state, options) {
    for (const chunk of await chunkLines(text, options.blockChars, options.signal)) {
        checkAborted(options.signal);
        const coordinate = chunk.startLine === chunk.endLine
            ? `line:${chunk.startLine}`
            : `lines:${chunk.startLine}-${chunk.endLine}`;
        if (!appendBlock(state, document, coordinate, headingFromLines(chunk.text.split('\n'), document.path), chunk.text, options.maxBlocks))
            break;
        await maybeYieldAfterBlock(state, options.signal);
    }
}
async function pdfBlocks(bytes, document, state, options) {
    const text = await parseDocument(bytes, 'pdf', { sheetRowLimit: 1 });
    const pages = splitPdfPages(text);
    pages: for (const [pageIndex, page] of pages.entries()) {
        checkAborted(options.signal);
        const chunks = await chunkLines(page, options.blockChars, options.signal);
        for (const chunk of chunks) {
            const base = `page:${pageIndex + 1}`;
            const coordinate = chunks.length === 1 ? base : `${base},lines:${chunk.startLine}-${chunk.endLine}`;
            if (!appendBlock(state, document, coordinate, headingFromLines(chunk.text.split('\n'), `Page ${pageIndex + 1}`), chunk.text, options.maxBlocks))
                break pages;
            await maybeYieldAfterBlock(state, options.signal);
        }
    }
}
export function splitPptxSlides(text) {
    const markers = [...text.matchAll(/^### Slide (\d+)\n/gmu)];
    return markers.map((marker, index) => {
        const start = (marker.index ?? 0) + marker[0].length;
        const end = markers[index + 1]?.index ?? text.length;
        return { slide: Number(marker[1]), text: text.slice(start, end).trim() };
    });
}
async function pptxBlocks(bytes, document, state, options) {
    const text = await parseDocument(bytes, 'pptx', { sheetRowLimit: 1 });
    const slides = splitPptxSlides(text);
    if (slides.length === 0) {
        await genericBlocks(text, document, state, options);
        return;
    }
    slides: for (const section of slides) {
        checkAborted(options.signal);
        const chunks = await chunkLines(section.text, options.blockChars, options.signal);
        for (const chunk of chunks) {
            const base = `slide:${section.slide}`;
            const coordinate = chunks.length === 1 ? base : `${base},lines:${chunk.startLine}-${chunk.endLine}`;
            if (!appendBlock(state, document, coordinate, headingFromLines(chunk.text.split('\n'), `Slide ${section.slide}`), chunk.text, options.maxBlocks))
                break slides;
            await maybeYieldAfterBlock(state, options.signal);
        }
    }
}
function columnName(index) {
    let value = index;
    let output = '';
    while (value > 0) {
        value -= 1;
        output = String.fromCharCode(65 + (value % 26)) + output;
        value = Math.floor(value / 26);
    }
    return output;
}
export function parseWorkbookInventory(value) {
    const countMatch = /^### Workbook \((\d+) sheets\)/u.exec(value);
    if (countMatch === null)
        throw new Error('cannot index XLSX: parser returned an invalid workbook inventory');
    const count = Number(countMatch[1]);
    const sheets = [];
    const entries = value.matchAll(/^(\d+)\. ([\s\S]*?) — used (?:empty|[A-Z]+\d+:[A-Z]+\d+); \d+ populated rows; \d+ non-empty cells$/gmu);
    for (const match of entries) {
        const name = match[2].normalize('NFC');
        if (/[\r\n]/u.test(name)) {
            throw new Error(`cannot index XLSX: worksheet name ${JSON.stringify(name)} contains a line break`);
        }
        sheets.push({ index: Number(match[1]), name });
    }
    if (sheets.length !== count) {
        throw new Error(`cannot index XLSX: inventory declared ${count} sheets but described ${sheets.length}`);
    }
    return sheets;
}
function renderSpreadsheetRow(columns, headerValues, values, rowNumber) {
    const output = [`row ${rowNumber}`];
    for (let index = 0; index < columns.length; index += 1) {
        const value = values[index] ?? '';
        const label = headerValues[index]?.trim();
        const key = label === undefined || label === '' ? columns[index] : `${columns[index]} (${label})`;
        if (value !== '')
            output.push(`${key}: ${value}`);
    }
    return output.join('\n');
}
async function xlsxBlocks(bytes, document, state, sheetIndexes, options) {
    // XLSX decompression and XML parsing are the dominant cost. Parse once,
    // then project every worksheet from the same in-memory workbook instead of
    // re-running read-excel-file N+1 times for N sheets.
    const workbook = await parseXlsxWorkbook(bytes);
    const inventory = projectXlsx(workbook, { sheetRowLimit: 1, listOnly: true });
    const sheets = parseWorkbookInventory(inventory);
    for (const sheet of sheets)
        sheetIndexes.set(sheet.name, sheet.index);
    sheets: for (const sheet of sheets) {
        checkAborted(options.signal);
        // Selecting one sheet asks the existing parser for all populated rows; no
        // parser implementation or default read_document path is changed here.
        const projection = projectXlsx(workbook, {
            sheetRowLimit: Number.MAX_SAFE_INTEGER,
            maxSheets: sheets.length,
            sheet: sheet.index
        });
        const lines = projection.split('\n');
        const headerIndex = lines.findIndex((line) => line === 'row' || line.startsWith('row\t'));
        if (headerIndex < 0)
            continue;
        const columns = lines[headerIndex].split('\t').slice(1);
        const rows = [];
        let scannedRows = 0;
        for (const line of lines.slice(headerIndex + 1)) {
            if (line.trim() === '' || line.startsWith('… truncated:'))
                continue;
            const cells = line.split('\t');
            const rowNumber = Number(cells.shift());
            if (!Number.isInteger(rowNumber) || rowNumber < 1)
                continue;
            rows.push({ rowNumber, values: cells });
            scannedRows += 1;
            if (scannedRows % COOPERATIVE_YIELD_INTERVAL === 0)
                await yieldToEventLoop(options.signal);
        }
        // The first row is often a title merged across columns. Prefer the first
        // row with at least two populated cells as the structural header; fall
        // back to the first populated row for single-column sheets.
        const headerValues = (rows.find((row) => row.values.filter((value) => value.trim() !== '').length >= 2) ?? rows[0])?.values ?? [];
        for (const { rowNumber, values } of rows) {
            const lastColumn = columnName(Math.max(columns.length, values.length, 1));
            const coordinate = `${formatWorksheetName(sheet.name)}!A${rowNumber}:${lastColumn}${rowNumber}`;
            const columnHeading = columns
                .map((column, index) => {
                const label = headerValues[index]?.trim();
                return label === undefined || label === '' ? column : `${column} ${label}`;
            })
                .join(' · ');
            const heading = `${sheet.name} · ${coordinate} · ${columnHeading}`;
            const rendered = renderSpreadsheetRow(columns, headerValues, values, rowNumber);
            for (const [partIndex, part] of splitLongLine(rendered, options.blockChars).entries()) {
                if (!appendBlock(state, document, partIndex === 0 ? coordinate : `${coordinate},part:${partIndex + 1}`, heading, part, options.maxBlocks))
                    break sheets;
                await maybeYieldAfterBlock(state, options.signal);
            }
        }
    }
}
function markTruncated(state, document, maxBlocks) {
    if (!state.truncated)
        return;
    const last = state.output.at(-1);
    if (last === undefined)
        return;
    const notice = `[Index truncated at ${maxBlocks} blocks; later document content is not searchable. Use read_document with a returned coordinate or sequential offset/limit paging. Marker: ${INDEX_TRUNCATION_MARKER}]`;
    last.heading = `${last.heading} · index truncated`;
    last.text = `${last.text}\n\n${notice}`;
    last.id = blockId(document, last.coordinate, last.ordinal, last.text);
}
/** Build stable, versioned blocks without changing any parser implementation. */
export async function buildDocumentBlocks(bytes, document, options) {
    if (!Number.isInteger(options.blockChars) || options.blockChars < 1) {
        throw new Error('blockChars must be a positive integer');
    }
    if (!Number.isInteger(options.maxBlocks) || options.maxBlocks < 1) {
        throw new Error('maxBlocks must be a positive integer');
    }
    checkAborted(options.signal);
    const output = [];
    const state = { output, truncated: false, appendedSinceYield: 0 };
    const sheetIndexes = new Map();
    if (document.format === 'pdf') {
        await pdfBlocks(bytes, document, state, options);
    }
    else if (document.format === 'pptx') {
        await pptxBlocks(bytes, document, state, options);
    }
    else if (document.format === 'xlsx') {
        await xlsxBlocks(bytes, document, state, sheetIndexes, options);
    }
    else {
        const text = await parseDocument(bytes, document.format, { sheetRowLimit: 1 });
        await genericBlocks(text, document, state, options);
    }
    markTruncated(state, document, options.maxBlocks);
    buildMetadata.set(output, {
        truncated: state.truncated,
        maxBlocks: options.maxBlocks,
        sheetIndexes
    });
    checkAborted(options.signal);
    return output;
}
