// XLSX cell text extraction via read-excel-file (read-only parser, no known
// advisories — replaces xlsx@0.18.5 which carries prototype-pollution CVEs).
// The parser streams the workbook internally; `sheetRowLimit` bounds the rows
// we keep for the model, and the fs layer already caps input bytes.
import readXlsxFile from 'read-excel-file/node';
function cellText(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }
    return String(value);
}
export async function parseXlsx(bytes, options) {
    const rows = await readXlsxFile(Buffer.from(bytes));
    const kept = rows.slice(0, options.sheetRowLimit);
    return kept.map((row) => row.map(cellText).join('\t').replace(/\s+$/, '')).join('\n');
}
