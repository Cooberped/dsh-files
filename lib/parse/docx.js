// Small, read-only DOCX projection. We deliberately own only the AI-facing
// text contract while reusing mature ZIP (fflate) and XML (saxen) primitives.
// This avoids Mammoth's vulnerable argparse -> lodash@3 dependency chain and
// keeps paragraph/table coordinates explicit enough for document reasoning.
import { strFromU8, unzipSync } from 'fflate';
import { Parser } from 'saxen';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAX_XML_PART_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 64 * 1024 * 1024;
const MAX_XML_PARTS = 64;
const MAIN_PART = 'word/document.xml';
const OPTIONAL_PART = /^word\/(?:footnotes|endnotes|header\d+|footer\d+)\.xml$/u;
function decodeXml(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    // fflate's UTF-8 decoder is small and already shared with XLSX extraction.
    return strFromU8(bytes);
}
function cleanParagraph(value) {
    return value
        .replace(/\r/g, '')
        .replace(/[ \u00a0]+\n/g, '\n')
        .replace(/\n[ \u00a0]+/g, '\n')
        .replace(/[ \u00a0]+$/g, '');
}
function projectWordXml(bytes, partName) {
    const parser = new Parser();
    parser.ns({ [WORD_NS]: 'w' });
    const lines = [];
    const rowStack = [];
    const cellStack = [];
    let paragraph = null;
    let textDepth = 0;
    let skippedRevisionDepth = 0;
    let omittedAltChunk = false;
    const appendBlock = (value) => {
        const cleaned = cleanParagraph(value);
        const activeCell = cellStack.at(-1);
        if (activeCell !== undefined) {
            activeCell.push(cleaned);
        }
        else {
            lines.push(...cleaned.split('\n'));
        }
    };
    parser.on('openTag', (name) => {
        if (name === 'w:del' || name === 'w:moveFrom')
            skippedRevisionDepth += 1;
        if (name === 'w:altChunk')
            omittedAltChunk = true;
        if (name === 'w:tr')
            rowStack.push([]);
        if (name === 'w:tc')
            cellStack.push([]);
        if (name === 'w:p')
            paragraph = [];
        if (name === 'w:t')
            textDepth += 1;
        if (paragraph !== null && skippedRevisionDepth === 0) {
            if (name === 'w:tab')
                paragraph.push('\t');
            if (name === 'w:br' || name === 'w:cr')
                paragraph.push('\n');
            if (name === 'w:noBreakHyphen')
                paragraph.push('\u2011');
            if (name === 'w:softHyphen')
                paragraph.push('\u00ad');
        }
    });
    parser.on('text', (value, decodeEntities) => {
        if (paragraph !== null && textDepth > 0 && skippedRevisionDepth === 0) {
            paragraph.push(decodeEntities(value));
        }
    });
    parser.on('cdata', (value) => {
        if (paragraph !== null && textDepth > 0 && skippedRevisionDepth === 0)
            paragraph.push(value);
    });
    parser.on('closeTag', (name) => {
        if (name === 'w:t')
            textDepth = Math.max(0, textDepth - 1);
        if (name === 'w:p') {
            appendBlock(paragraph?.join('') ?? '');
            paragraph = null;
        }
        if (name === 'w:tc') {
            const cell = cellStack.pop() ?? [];
            const rendered = cell
                .map((value) => value.replace(/\s*\n\s*/g, ' / ').trim())
                .filter((value) => value !== '')
                .join(' / ');
            const row = rowStack.at(-1);
            if (row !== undefined)
                row.push(rendered);
            else
                appendBlock(rendered);
        }
        if (name === 'w:tr') {
            const rendered = (rowStack.pop() ?? []).join('\t').replace(/[ \t]+$/g, '');
            appendBlock(rendered);
        }
        if (name === 'w:del' || name === 'w:moveFrom') {
            skippedRevisionDepth = Math.max(0, skippedRevisionDepth - 1);
        }
    });
    try {
        const parseError = parser.parse(decodeXml(bytes));
        if (parseError instanceof Error)
            throw parseError;
    }
    catch (err) {
        throw new Error(`invalid DOCX XML part "${partName}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = lines
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, omittedAltChunk };
}
function partLabel(name) {
    const base = name.slice('word/'.length, -'.xml'.length);
    if (base === 'footnotes')
        return 'Footnotes';
    if (base === 'endnotes')
        return 'Endnotes';
    if (base.startsWith('header'))
        return `Header ${base.slice('header'.length)}`;
    if (base.startsWith('footer'))
        return `Footer ${base.slice('footer'.length)}`;
    return base;
}
function extractRelevantParts(bytes) {
    let acceptedParts = 0;
    let acceptedBytes = 0;
    try {
        return unzipSync(bytes, {
            filter: (file) => {
                const wanted = file.name === MAIN_PART || OPTIONAL_PART.test(file.name);
                if (!wanted)
                    return false;
                acceptedParts += 1;
                acceptedBytes += file.originalSize;
                if (acceptedParts > MAX_XML_PARTS)
                    throw new Error(`too many relevant XML parts (limit ${MAX_XML_PARTS})`);
                if (file.originalSize > MAX_XML_PART_BYTES) {
                    throw new Error(`XML part "${file.name}" is ${file.originalSize} bytes (limit ${MAX_XML_PART_BYTES})`);
                }
                if (acceptedBytes > MAX_TOTAL_XML_BYTES) {
                    throw new Error(`relevant XML expands to ${acceptedBytes} bytes (limit ${MAX_TOTAL_XML_BYTES})`);
                }
                return true;
            }
        });
    }
    catch (err) {
        throw new Error(`cannot unpack DOCX safely: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export async function parseDocx(bytes) {
    const parts = extractRelevantParts(bytes);
    const main = parts[MAIN_PART];
    if (main === undefined)
        throw new Error(`invalid DOCX package: missing ${MAIN_PART}`);
    const output = [];
    let omittedAltChunk = false;
    const body = projectWordXml(main, MAIN_PART);
    omittedAltChunk ||= body.omittedAltChunk;
    if (body.text !== '')
        output.push(body.text);
    const optionalNames = Object.keys(parts)
        .filter((name) => name !== MAIN_PART)
        .sort((a, b) => a.localeCompare(b, 'en'));
    for (const name of optionalNames) {
        const projected = projectWordXml(parts[name], name);
        omittedAltChunk ||= projected.omittedAltChunk;
        if (projected.text !== '')
            output.push(`### ${partLabel(name)}\n${projected.text}`);
    }
    if (omittedAltChunk) {
        output.push('[Notice: embedded altChunk content is not expanded by this read-only parser.]');
    }
    return output.length > 0 ? output.join('\n\n') : '(DOCX contains no extractable text)';
}
