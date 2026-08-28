// AI-facing XLSX projection built on read-excel-file's read-only decoder. We
// preflight the ZIP central directory before handing bytes to the decoder so
// attacker-controlled expansion sizes can never become unbounded allocations.
// The projection owns workbook inventory, value-density statistics, A1 range
// selection, stable coordinates, and honest truncation semantics.
import readXlsxFile from 'read-excel-file/universal';
import { strFromU8, unzipSync } from 'fflate';
import { Parser } from 'saxen';
import { zipMembers } from "../detect.js";
const MAX_EXCEL_ROW = 1_048_576;
const MAX_EXCEL_COLUMN = 16_384;
// Prevent an otherwise tiny workbook from requesting a billion-cell string.
// Larger tasks can split the worksheet into several targeted calls.
const MAX_RANGE_CELLS = 100_000;
// These limits apply to every XML member read-excel-file will extract, not just
// xl/ paths. Limiting only xl/ would leave [Content_Types].xml (and any hostile
// root-level *.xml) able to trigger the same decompressor allocation.
const MAX_XLSX_XML_PART_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_XLSX_XML_BYTES = 128 * 1024 * 1024;
const MAX_XLSX_XML_PARTS = 4096;
const MAX_XLSX_MEMBER_NAME_BYTES = 1024;
// read-excel-file materializes gaps implied by row/cell coordinates. Keep both
// row-array overhead and the final rectangular projection bounded even when a
// tiny worksheet XML references the far edge of Excel's coordinate space.
const MAX_XLSX_LOGICAL_ROWS_PER_SHEET = 200_000;
const MAX_XLSX_LOGICAL_CELLS_PER_SHEET = 2_000_000;
const MAX_TOTAL_XLSX_LOGICAL_CELLS = 5_000_000;
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels';
const WORKSHEET_REL_TRANSITIONAL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WORKSHEET_REL_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet';
function cellText(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date) {
        const iso = value.toISOString().replace('T', ' ').slice(0, 19);
        return iso.endsWith(' 00:00:00') ? iso.slice(0, 10) : iso;
    }
    // Tabs and newlines are structural delimiters in the AI projection.
    return String(value).replace(/[\t\r\n]+/g, ' ').trim();
}
function isPopulated(value) {
    return value !== null && value !== undefined && cellText(value) !== '';
}
function sheetStats(rows) {
    let columns = 0;
    let populatedRows = 0;
    let nonEmptyCells = 0;
    let firstRow;
    let firstColumn;
    let lastRow;
    let lastColumn;
    for (const [rowIndex, row] of rows.entries()) {
        columns = Math.max(columns, row.length);
        let populated = false;
        for (const [columnIndex, value] of row.entries()) {
            if (!isPopulated(value))
                continue;
            populated = true;
            nonEmptyCells += 1;
            const rowNumber = rowIndex + 1;
            const columnNumber = columnIndex + 1;
            firstRow = firstRow === undefined ? rowNumber : Math.min(firstRow, rowNumber);
            firstColumn = firstColumn === undefined ? columnNumber : Math.min(firstColumn, columnNumber);
            lastRow = lastRow === undefined ? rowNumber : Math.max(lastRow, rowNumber);
            lastColumn = lastColumn === undefined ? columnNumber : Math.max(lastColumn, columnNumber);
        }
        if (populated)
            populatedRows += 1;
    }
    return { rows: rows.length, columns, populatedRows, nonEmptyCells, firstRow, firstColumn, lastRow, lastColumn };
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
function columnIndex(label) {
    let value = 0;
    for (const char of label.toUpperCase())
        value = value * 26 + char.charCodeAt(0) - 64;
    return value;
}
function parseCellRange(raw) {
    const value = raw.trim().toUpperCase();
    const match = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/.exec(value);
    if (match === null)
        throw new Error(`invalid cell_range "${raw}" (expected A1 or A1:F40)`);
    const startColumn = columnIndex(match[1]);
    const startRow = Number(match[2]);
    const endColumn = columnIndex(match[3] ?? match[1]);
    const endRow = Number(match[4] ?? match[2]);
    if (startColumn < 1 || startColumn > MAX_EXCEL_COLUMN ||
        endColumn < 1 || endColumn > MAX_EXCEL_COLUMN ||
        startRow < 1 || startRow > MAX_EXCEL_ROW ||
        endRow < 1 || endRow > MAX_EXCEL_ROW ||
        endColumn < startColumn || endRow < startRow) {
        throw new Error(`invalid cell_range "${raw}" (range is reversed or outside Excel limits)`);
    }
    const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
    if (cells > MAX_RANGE_CELLS) {
        throw new Error(`cell_range "${raw}" contains ${cells} cells; split it into ranges of at most ${MAX_RANGE_CELLS} cells`);
    }
    return {
        startColumn,
        startRow,
        endColumn,
        endRow,
        normalized: `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`
    };
}
function rowsToCoordinateText(rows, range) {
    const headers = ['row'];
    for (let column = range.startColumn; column <= range.endColumn; column += 1)
        headers.push(columnName(column));
    const lines = [headers.join('\t')];
    for (let rowNumber = range.startRow; rowNumber <= range.endRow; rowNumber += 1) {
        const source = rows[rowNumber - 1] ?? [];
        const values = [String(rowNumber)];
        for (let column = range.startColumn; column <= range.endColumn; column += 1) {
            values.push(cellText(source[column - 1]));
        }
        // Keep empty rows inside an explicit range so coordinates cannot shift.
        lines.push(values.join('\t').replace(/\s+$/, ''));
    }
    return lines.join('\n');
}
function automaticRowsToText(rows, rowLimit) {
    const stats = sheetStats(rows);
    if (stats.rows === 0 || stats.columns === 0)
        return { text: '(no cell values)', truncated: false };
    const kept = [];
    for (let index = 0; index < rows.length && kept.length < rowLimit; index += 1) {
        if (rows[index].some(isPopulated))
            kept.push({ number: index + 1, row: rows[index] });
    }
    const headers = ['row'];
    for (let column = 1; column <= stats.columns; column += 1)
        headers.push(columnName(column));
    const lines = [headers.join('\t')];
    for (const entry of kept) {
        const values = [String(entry.number)];
        for (let column = 1; column <= stats.columns; column += 1)
            values.push(cellText(entry.row[column - 1]));
        lines.push(values.join('\t').replace(/\s+$/, ''));
    }
    return { text: lines.join('\n'), truncated: stats.populatedRows > kept.length };
}
function workbookInventory(sheets) {
    if (sheets.length === 0)
        return '### Workbook\n(no worksheets)';
    const lines = [`### Workbook (${sheets.length} sheets)`];
    for (const [index, sheet] of sheets.entries()) {
        const stats = sheetStats(sheet.data);
        const usedRange = stats.firstRow !== undefined && stats.firstColumn !== undefined && stats.lastRow !== undefined && stats.lastColumn !== undefined
            ? `${columnName(stats.firstColumn)}${stats.firstRow}:${columnName(stats.lastColumn)}${stats.lastRow}`
            : 'empty';
        lines.push(`${index + 1}. ${sheet.sheet} — used ${usedRange}; ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells`);
    }
    lines.push('Use sheet with optional cell_range to read only the worksheet region needed for the task.');
    return lines.join('\n');
}
function selectedSheet(sheets, index) {
    if (index < 1 || index > sheets.length) {
        const available = sheets.map((sheet, i) => `${i + 1}. ${sheet.sheet}`).join(', ');
        throw new Error(`sheet ${index} out of range: workbook has ${sheets.length} sheet(s) — ${available}`);
    }
    return sheets[index - 1];
}
function isExtractedXmlPart(name) {
    // Keep this in lockstep with read-excel-file's filterZipArchiveEntry().
    return name.endsWith('.xml') || name.endsWith('.xml.rels');
}
function assertSafeXlsxArchive(bytes) {
    const members = zipMembers(bytes);
    if (members === null)
        throw new Error('cannot unpack XLSX safely: invalid, unsupported, or over-complex ZIP central directory');
    let extractedParts = 0;
    let extractedBytes = 0;
    for (const member of members) {
        if (member.nameBytes > MAX_XLSX_MEMBER_NAME_BYTES) {
            throw new Error(`cannot unpack XLSX safely: member name is ${member.nameBytes} bytes (limit ${MAX_XLSX_MEMBER_NAME_BYTES})`);
        }
        if (!isExtractedXmlPart(member.name))
            continue;
        extractedParts += 1;
        if (extractedParts > MAX_XLSX_XML_PARTS) {
            throw new Error(`cannot unpack XLSX safely: too many XML parts (limit ${MAX_XLSX_XML_PARTS})`);
        }
        if (member.originalSize > MAX_XLSX_XML_PART_BYTES) {
            throw new Error(`cannot unpack XLSX safely: XML part "${member.name}" declares ${member.originalSize} bytes ` +
                `(limit ${MAX_XLSX_XML_PART_BYTES})`);
        }
        extractedBytes += member.originalSize;
        if (extractedBytes > MAX_TOTAL_XLSX_XML_BYTES) {
            throw new Error(`cannot unpack XLSX safely: XML parts declare ${extractedBytes} bytes in total ` +
                `(limit ${MAX_TOTAL_XLSX_XML_BYTES})`);
        }
    }
}
function decodeXml(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    return strFromU8(bytes);
}
function localName(name) {
    const colon = name.lastIndexOf(':');
    return colon < 0 ? name : name.slice(colon + 1);
}
function decodedAttribute(attributes, decodeEntities, wanted) {
    // read-excel-file removes namespace prefixes before consuming attributes.
    // Keep the last local-name match so duplicate prefixed/unprefixed attributes
    // resolve the same way as its in-place normalization loop.
    let found;
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'xmlns' || name.startsWith('xmlns:'))
            continue;
        if (localName(name) === wanted)
            found = decodeEntities(value);
    }
    return found;
}
function extractXlsxParts(bytes, wanted) {
    try {
        return unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
    }
    catch (error) {
        throw new Error(`cannot inspect XLSX safely: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function worksheetPartNames(bytes) {
    const parts = extractXlsxParts(bytes, new Set([WORKBOOK_RELS_PART]));
    const relationshipXml = parts[WORKBOOK_RELS_PART];
    if (relationshipXml === undefined) {
        throw new Error(`cannot inspect XLSX safely: missing ${WORKBOOK_RELS_PART}`);
    }
    const output = new Set();
    const parser = new Parser();
    parser.on('openTag', (name, getAttributes, decodeEntities) => {
        if (localName(name) !== 'Relationship')
            return;
        const attributes = getAttributes();
        const type = decodedAttribute(attributes, decodeEntities, 'Type');
        if (type !== WORKSHEET_REL_TRANSITIONAL && type !== WORKSHEET_REL_STRICT)
            return;
        if (decodedAttribute(attributes, decodeEntities, 'TargetMode') === 'External')
            return;
        const target = decodedAttribute(attributes, decodeEntities, 'Target');
        if (target === undefined || target === '') {
            throw new Error('worksheet relationship has no Target');
        }
        // Match read-excel-file's supported relationship resolution, including
        // custom paths and the absolute /xl/... form seen in real workbooks.
        output.add(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    });
    try {
        const parseError = parser.parse(decodeXml(relationshipXml));
        if (parseError instanceof Error)
            throw parseError;
    }
    catch (error) {
        throw new Error(`cannot inspect XLSX safely: invalid ${WORKBOOK_RELS_PART}: ` +
            `${error instanceof Error ? error.message : String(error)}`);
    }
    return output;
}
function positiveDecimal(raw, maximum, label) {
    const value = raw.trim();
    if (value === '')
        throw new Error(`${label} is empty`);
    let output = 0;
    for (let index = 0; index < value.length; index += 1) {
        const digit = value.charCodeAt(index) - 48;
        if (digit < 0 || digit > 9)
            throw new Error(`${label} ${JSON.stringify(raw)} is not a positive integer`);
        output = output * 10 + digit;
        if (!Number.isSafeInteger(output) || output > maximum) {
            throw new Error(`${label} ${JSON.stringify(raw)} is outside the supported Excel coordinate range`);
        }
    }
    if (output < 1)
        throw new Error(`${label} ${JSON.stringify(raw)} must be at least 1`);
    return output;
}
function cellCoordinates(raw, partName) {
    const value = raw.trim();
    let index = 0;
    let column = 0;
    while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code < 65 || code > 90)
            break;
        column = column * 26 + code - 64;
        if (column > MAX_EXCEL_COLUMN) {
            throw new Error(`cell reference ${JSON.stringify(raw)} in ${partName} exceeds column XFD`);
        }
        index += 1;
    }
    if (index === 0 || index === value.length) {
        throw new Error(`invalid cell reference ${JSON.stringify(raw)} in ${partName}`);
    }
    const row = positiveDecimal(value.slice(index), MAX_EXCEL_ROW, `cell row in ${partName}`);
    return { row, column };
}
function logicalCells(rows, columns) {
    return rows === 0 ? 0 : rows * Math.max(columns, 1);
}
function assertSheetGrid(partName, rows, columns) {
    const cells = logicalCells(rows, columns);
    if (cells > MAX_XLSX_LOGICAL_CELLS_PER_SHEET) {
        throw new Error(`cannot inspect XLSX safely: worksheet "${partName}" declares a ${rows}x${Math.max(columns, 1)} ` +
            `logical grid (${cells} cells; limit ${MAX_XLSX_LOGICAL_CELLS_PER_SHEET})`);
    }
    if (rows > MAX_XLSX_LOGICAL_ROWS_PER_SHEET) {
        throw new Error(`cannot inspect XLSX safely: worksheet "${partName}" declares ${rows} logical rows ` +
            `(limit ${MAX_XLSX_LOGICAL_ROWS_PER_SHEET})`);
    }
}
function inspectWorksheetGrid(bytes, partName) {
    let sheetDataStarted = false;
    let maxRow = 0;
    let maxColumn = 0;
    const parser = new Parser();
    parser.on('openTag', (name, getAttributes, decodeEntities) => {
        const element = localName(name);
        if (element === 'sheetData') {
            sheetDataStarted = true;
            return;
        }
        // Match read-excel-file: once sheetData starts, subsequent row/c tags are
        // interpreted as data. Parsing tags structurally avoids attribute-order,
        // namespace-prefix and entity-encoding bypasses.
        if (!sheetDataStarted || (element !== 'row' && element !== 'c'))
            return;
        const attributes = getAttributes();
        const reference = decodedAttribute(attributes, decodeEntities, 'r');
        if (element === 'row') {
            const row = reference === undefined
                ? maxRow + 1
                : positiveDecimal(reference, MAX_EXCEL_ROW, `row coordinate in ${partName}`);
            maxRow = Math.max(maxRow, row);
        }
        else {
            if (reference === undefined)
                throw new Error(`cell without r coordinate in ${partName}`);
            const coordinates = cellCoordinates(reference, partName);
            maxRow = Math.max(maxRow, coordinates.row);
            maxColumn = Math.max(maxColumn, coordinates.column);
        }
        assertSheetGrid(partName, maxRow, maxColumn);
    });
    try {
        const parseError = parser.parse(decodeXml(bytes));
        if (parseError instanceof Error)
            throw parseError;
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('cannot inspect XLSX safely:'))
            throw error;
        throw new Error(`cannot inspect XLSX safely: invalid worksheet XML part "${partName}": ` +
            `${error instanceof Error ? error.message : String(error)}`);
    }
    return logicalCells(maxRow, maxColumn);
}
function assertSafeXlsxLogicalGrid(bytes) {
    const worksheetParts = worksheetPartNames(bytes);
    const parts = extractXlsxParts(bytes, worksheetParts);
    let workbookCells = 0;
    for (const partName of worksheetParts) {
        const part = parts[partName];
        if (part === undefined)
            throw new Error(`cannot inspect XLSX safely: missing worksheet part "${partName}"`);
        workbookCells += inspectWorksheetGrid(part, partName);
        if (workbookCells > MAX_TOTAL_XLSX_LOGICAL_CELLS) {
            throw new Error(`cannot inspect XLSX safely: workbook declares ${workbookCells} logical cells ` +
                `(limit ${MAX_TOTAL_XLSX_LOGICAL_CELLS})`);
        }
    }
}
/** Parse and validate a workbook once so callers can project many sheets. */
export async function parseXlsxWorkbook(bytes) {
    assertSafeXlsxArchive(bytes);
    assertSafeXlsxLogicalGrid(bytes);
    // The universal entry uses fflate's central-directory sizes. That makes the
    // preflight limits above authoritative for allocations. The Node entry uses
    // streaming local-header sizes, so a central-only preflight would not close
    // the local/central mismatch case.
    const input = new Uint8Array(bytes).buffer;
    return readXlsxFile(input);
}
/** Project an already parsed workbook without decompressing it again. */
export function projectXlsx(sheets, options) {
    if (options.cellRange !== undefined && options.sheet === undefined) {
        throw new Error('cell_range requires sheet: list the workbook, then select a worksheet and range');
    }
    if (options.listOnly === true)
        return workbookInventory(sheets);
    if (options.sheet !== undefined) {
        const sheet = selectedSheet(sheets, options.sheet);
        const stats = sheetStats(sheet.data);
        if (options.cellRange !== undefined) {
            const range = parseCellRange(options.cellRange);
            return [
                `### Sheet ${options.sheet}/${sheets.length}: ${sheet.sheet} — range ${range.normalized}`,
                `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells in worksheet`,
                rowsToCoordinateText(sheet.data, range)
            ].join('\n\n');
        }
        const projection = automaticRowsToText(sheet.data, Math.max(options.sheetRowLimit, stats.populatedRows));
        return [
            `### Sheet ${options.sheet}/${sheets.length}: ${sheet.sheet}`,
            `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells; ${stats.columns} columns`,
            projection.text
        ].join('\n\n');
    }
    const maxSheets = options.maxSheets ?? 5;
    const parts = [];
    let omittedSheets = 0;
    for (const [index, sheet] of sheets.entries()) {
        if (index >= maxSheets) {
            omittedSheets += 1;
            continue;
        }
        const stats = sheetStats(sheet.data);
        const projection = automaticRowsToText(sheet.data, options.sheetRowLimit);
        parts.push([
            `### Sheet ${index + 1}/${sheets.length}: ${sheet.sheet}`,
            `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells; ${stats.columns} columns`,
            projection.text,
            ...(projection.truncated
                ? [`… truncated: showing ${options.sheetRowLimit}/${stats.populatedRows} populated rows; call with sheet: ${index + 1}`]
                : [])
        ].join('\n\n'));
    }
    if (omittedSheets > 0)
        parts.push(`… ${omittedSheets} more sheets omitted; call list_sheets first`);
    return parts.join('\n\n');
}
export async function parseXlsx(bytes, options) {
    return projectXlsx(await parseXlsxWorkbook(bytes), options);
}
