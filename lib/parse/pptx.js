// Small, read-only PPTX projection. PPTX is an OOXML ZIP package, so reuse
// the same bounded fflate + saxen primitives as DOCX instead of spawning
// Python or adding a presentation-sized dependency tree.
import { posix } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { Parser } from 'saxen';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PRESENTATION_PART = 'ppt/presentation.xml';
const PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';
const MAX_XML_PART_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 128 * 1024 * 1024;
const MAX_XML_PARTS = 4096;
function decodeXml(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    return strFromU8(bytes);
}
function parseXml(bytes, partName, configure) {
    const parser = new Parser();
    configure(parser);
    try {
        const parseError = parser.parse(decodeXml(bytes));
        if (parseError instanceof Error)
            throw parseError;
    }
    catch (error) {
        throw new Error(`invalid PPTX XML part "${partName}": ${error instanceof Error ? error.message : String(error)}`);
    }
}
function extractSelectedParts(bytes, wanted, budget) {
    try {
        return unzipSync(bytes, {
            filter: (file) => {
                if (!wanted.has(file.name))
                    return false;
                budget.parts += 1;
                budget.bytes += file.originalSize;
                if (budget.parts > MAX_XML_PARTS)
                    throw new Error(`too many relevant XML parts (limit ${MAX_XML_PARTS})`);
                if (file.originalSize > MAX_XML_PART_BYTES) {
                    throw new Error(`XML part "${file.name}" is ${file.originalSize} bytes (limit ${MAX_XML_PART_BYTES})`);
                }
                if (budget.bytes > MAX_TOTAL_XML_BYTES) {
                    throw new Error(`relevant XML expands to ${budget.bytes} bytes (limit ${MAX_TOTAL_XML_BYTES})`);
                }
                return true;
            }
        });
    }
    catch (error) {
        throw new Error(`cannot unpack PPTX safely: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function relationships(bytes, partName) {
    const output = new Map();
    parseXml(bytes, partName, (parser) => {
        parser.ns({ [PACKAGE_REL_NS]: 'rel' });
        parser.on('openTag', (name, attrGetter) => {
            if (name !== 'rel:Relationship')
                return;
            const attrs = attrGetter();
            if (attrs.TargetMode === 'External')
                return;
            const id = attrs.Id;
            const type = attrs.Type;
            const target = attrs.Target;
            if (typeof id !== 'string' || id === '' || typeof type !== 'string' || typeof target !== 'string' || target === '') {
                throw new Error(`invalid relationship in ${partName}`);
            }
            if (output.has(id))
                throw new Error(`duplicate relationship ${id} in ${partName}`);
            output.set(id, { type, target });
        });
    });
    return output;
}
function presentationSlideIds(bytes) {
    const output = [];
    parseXml(bytes, PRESENTATION_PART, (parser) => {
        parser.ns({ [PRESENTATION_NS]: 'p', [OFFICE_REL_NS]: 'r' });
        parser.on('openTag', (name, attrGetter) => {
            if (name !== 'p:sldId')
                return;
            const id = attrGetter()['r:id'];
            if (typeof id !== 'string' || id === '')
                throw new Error(`slide entry without r:id in ${PRESENTATION_PART}`);
            output.push(id);
        });
    });
    return output;
}
function resolvePart(sourcePart, target) {
    const portableTarget = target.replace(/\\/g, '/');
    const resolved = portableTarget.startsWith('/')
        ? posix.normalize(portableTarget.slice(1))
        : posix.normalize(posix.join(posix.dirname(sourcePart), portableTarget));
    if (resolved === '' || resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
        throw new Error(`unsafe PPTX relationship target "${target}" from ${sourcePart}`);
    }
    return resolved;
}
function relationshipsPart(sourcePart) {
    return posix.join(posix.dirname(sourcePart), '_rels', `${posix.basename(sourcePart)}.rels`);
}
function cleanParagraph(value) {
    return value
        .replace(/\r/g, '')
        .replace(/[ \u00a0]+\n/g, '\n')
        .replace(/\n[ \u00a0]+/g, '\n')
        .trim();
}
function projectDrawingText(bytes, partName) {
    const lines = [];
    let paragraph = null;
    let textDepth = 0;
    parseXml(bytes, partName, (parser) => {
        parser.ns({ [DRAWING_NS]: 'a' });
        parser.on('openTag', (name) => {
            if (name === 'a:p')
                paragraph = [];
            if (name === 'a:t')
                textDepth += 1;
            if (paragraph !== null && name === 'a:br')
                paragraph.push('\n');
            if (paragraph !== null && name === 'a:tab')
                paragraph.push('\t');
        });
        parser.on('text', (value, decodeEntities) => {
            if (paragraph !== null && textDepth > 0)
                paragraph.push(decodeEntities(value));
        });
        parser.on('cdata', (value) => {
            if (paragraph !== null && textDepth > 0)
                paragraph.push(value);
        });
        parser.on('closeTag', (name) => {
            if (name === 'a:t')
                textDepth = Math.max(0, textDepth - 1);
            if (name !== 'a:p')
                return;
            const cleaned = cleanParagraph(paragraph?.join('') ?? '');
            if (cleaned !== '')
                lines.push(...cleaned.split('\n'));
            paragraph = null;
        });
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function notePartForSlide(parts, slidePart) {
    const relsPart = relationshipsPart(slidePart);
    const relsBytes = parts[relsPart];
    if (relsBytes === undefined)
        return undefined;
    const note = [...relationships(relsBytes, relsPart).values()]
        .find((entry) => entry.type.endsWith('/notesSlide'));
    return note === undefined ? undefined : resolvePart(slidePart, note.target);
}
export async function parsePptx(bytes) {
    // OOXML relationships, not conventional `slide1.xml` names, define the
    // presentation. Read only the two bootstrap parts first, then selectively
    // expand the relationship targets. This accepts legal custom part names
    // without inflating unrelated charts/media or weakening the ZIP budget.
    const budget = { parts: 0, bytes: 0 };
    const parts = extractSelectedParts(bytes, new Set([PRESENTATION_PART, PRESENTATION_RELS_PART]), budget);
    const presentation = parts[PRESENTATION_PART];
    const presentationRels = parts[PRESENTATION_RELS_PART];
    if (presentation === undefined)
        throw new Error(`invalid PPTX package: missing ${PRESENTATION_PART}`);
    if (presentationRels === undefined)
        throw new Error(`invalid PPTX package: missing ${PRESENTATION_RELS_PART}`);
    const rels = relationships(presentationRels, PRESENTATION_RELS_PART);
    const slideIds = presentationSlideIds(presentation);
    if (slideIds.length === 0)
        return '(PPTX contains no slides)';
    const orderedSlides = [];
    const slideParts = new Set();
    for (const relationshipId of slideIds) {
        const relationship = rels.get(relationshipId);
        if (relationship === undefined || !relationship.type.endsWith('/slide')) {
            throw new Error(`invalid PPTX package: slide relationship ${relationshipId} is missing or not a slide`);
        }
        const part = resolvePart(PRESENTATION_PART, relationship.target);
        orderedSlides.push({ relationshipId, part });
        slideParts.add(part);
        slideParts.add(relationshipsPart(part));
    }
    Object.assign(parts, extractSelectedParts(bytes, slideParts, budget));
    const noteParts = new Set();
    for (const slide of orderedSlides) {
        const notePart = notePartForSlide(parts, slide.part);
        if (notePart !== undefined)
            noteParts.add(notePart);
    }
    if (noteParts.size > 0)
        Object.assign(parts, extractSelectedParts(bytes, noteParts, budget));
    const output = [];
    for (const [index, slide] of orderedSlides.entries()) {
        const slidePart = slide.part;
        const slideBytes = parts[slidePart];
        if (slideBytes === undefined) {
            throw new Error(`invalid PPTX package: missing slide part ${slidePart}`);
        }
        const slideText = projectDrawingText(slideBytes, slidePart);
        const section = [`### Slide ${index + 1}`, slideText === '' ? '(no extractable slide text)' : slideText];
        const notePart = notePartForSlide(parts, slidePart);
        if (notePart !== undefined) {
            const noteBytes = parts[notePart];
            if (noteBytes === undefined) {
                throw new Error(`invalid PPTX package: missing notes part ${notePart}`);
            }
            const noteText = projectDrawingText(noteBytes, notePart);
            if (noteText !== '')
                section.push('#### Speaker notes', noteText);
        }
        output.push(section.join('\n'));
    }
    return output.join('\n\n');
}
