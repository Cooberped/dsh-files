// AI-facing XLSX projection built on read-excel-file's read-only decoder. We
// preflight the ZIP central directory before handing bytes to the decoder so
// attacker-controlled expansion sizes can never become unbounded allocations.
// The projection owns workbook inventory, value-density statistics, A1 range
// selection, stable coordinates, and honest truncation semantics.

import readXlsxFile, { type Sheet, type SheetData } from 'read-excel-file/universal'
import { zipMembers } from '../detect.ts'

const MAX_EXCEL_ROW = 1_048_576
const MAX_EXCEL_COLUMN = 16_384
// Prevent an otherwise tiny workbook from requesting a billion-cell string.
// Larger tasks can split the worksheet into several targeted calls.
const MAX_RANGE_CELLS = 100_000
// These limits apply to every XML member read-excel-file will extract, not just
// xl/ paths. Limiting only xl/ would leave [Content_Types].xml (and any hostile
// root-level *.xml) able to trigger the same decompressor allocation.
const MAX_XLSX_XML_PART_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_XLSX_XML_BYTES = 128 * 1024 * 1024
const MAX_XLSX_XML_PARTS = 4096
const MAX_XLSX_MEMBER_NAME_BYTES = 1024

export type XlsxWorkbook = Sheet[]

export interface XlsxParseOptions {
  sheetRowLimit: number
  maxSheets?: number
  /** 1-based worksheet index. */
  sheet?: number
  /** Build a structure inventory instead of returning cell values. */
  listOnly?: boolean
  /** Optional A1 range, for example A1:F40. Requires `sheet`. */
  cellRange?: string
}

interface CellRange {
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
  normalized: string
}

interface SheetStats {
  rows: number
  columns: number
  populatedRows: number
  nonEmptyCells: number
  firstRow?: number
  firstColumn?: number
  lastRow?: number
  lastColumn?: number
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const iso = value.toISOString().replace('T', ' ').slice(0, 19)
    return iso.endsWith(' 00:00:00') ? iso.slice(0, 10) : iso
  }
  // Tabs and newlines are structural delimiters in the AI projection.
  return String(value).replace(/[\t\r\n]+/g, ' ').trim()
}

function isPopulated(value: unknown): boolean {
  return value !== null && value !== undefined && cellText(value) !== ''
}

function sheetStats(rows: SheetData): SheetStats {
  let columns = 0
  let populatedRows = 0
  let nonEmptyCells = 0
  let firstRow: number | undefined
  let firstColumn: number | undefined
  let lastRow: number | undefined
  let lastColumn: number | undefined
  for (const [rowIndex, row] of rows.entries()) {
    columns = Math.max(columns, row.length)
    let populated = false
    for (const [columnIndex, value] of row.entries()) {
      if (!isPopulated(value)) continue
      populated = true
      nonEmptyCells += 1
      const rowNumber = rowIndex + 1
      const columnNumber = columnIndex + 1
      firstRow = firstRow === undefined ? rowNumber : Math.min(firstRow, rowNumber)
      firstColumn = firstColumn === undefined ? columnNumber : Math.min(firstColumn, columnNumber)
      lastRow = lastRow === undefined ? rowNumber : Math.max(lastRow, rowNumber)
      lastColumn = lastColumn === undefined ? columnNumber : Math.max(lastColumn, columnNumber)
    }
    if (populated) populatedRows += 1
  }
  return { rows: rows.length, columns, populatedRows, nonEmptyCells, firstRow, firstColumn, lastRow, lastColumn }
}

function columnName(index: number): string {
  let value = index
  let output = ''
  while (value > 0) {
    value -= 1
    output = String.fromCharCode(65 + (value % 26)) + output
    value = Math.floor(value / 26)
  }
  return output
}

function columnIndex(label: string): number {
  let value = 0
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

function parseCellRange(raw: string): CellRange {
  const value = raw.trim().toUpperCase()
  const match = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/.exec(value)
  if (match === null) throw new Error(`invalid cell_range "${raw}" (expected A1 or A1:F40)`)
  const startColumn = columnIndex(match[1])
  const startRow = Number(match[2])
  const endColumn = columnIndex(match[3] ?? match[1])
  const endRow = Number(match[4] ?? match[2])
  if (
    startColumn < 1 || startColumn > MAX_EXCEL_COLUMN ||
    endColumn < 1 || endColumn > MAX_EXCEL_COLUMN ||
    startRow < 1 || startRow > MAX_EXCEL_ROW ||
    endRow < 1 || endRow > MAX_EXCEL_ROW ||
    endColumn < startColumn || endRow < startRow
  ) {
    throw new Error(`invalid cell_range "${raw}" (range is reversed or outside Excel limits)`)
  }
  const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1)
  if (cells > MAX_RANGE_CELLS) {
    throw new Error(`cell_range "${raw}" contains ${cells} cells; split it into ranges of at most ${MAX_RANGE_CELLS} cells`)
  }
  return {
    startColumn,
    startRow,
    endColumn,
    endRow,
    normalized: `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`
  }
}

function rowsToCoordinateText(
  rows: SheetData,
  range: Pick<CellRange, 'startColumn' | 'startRow' | 'endColumn' | 'endRow'>
): string {
  const headers = ['row']
  for (let column = range.startColumn; column <= range.endColumn; column += 1) headers.push(columnName(column))
  const lines = [headers.join('\t')]
  for (let rowNumber = range.startRow; rowNumber <= range.endRow; rowNumber += 1) {
    const source = rows[rowNumber - 1] ?? []
    const values = [String(rowNumber)]
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(cellText(source[column - 1]))
    }
    // Keep empty rows inside an explicit range so coordinates cannot shift.
    lines.push(values.join('\t').replace(/\s+$/, ''))
  }
  return lines.join('\n')
}

function automaticRowsToText(rows: SheetData, rowLimit: number): { text: string; truncated: boolean } {
  const stats = sheetStats(rows)
  if (stats.rows === 0 || stats.columns === 0) return { text: '(no cell values)', truncated: false }
  const kept: Array<{ number: number; row: SheetData[number] }> = []
  for (let index = 0; index < rows.length && kept.length < rowLimit; index += 1) {
    if (rows[index].some(isPopulated)) kept.push({ number: index + 1, row: rows[index] })
  }
  const headers = ['row']
  for (let column = 1; column <= stats.columns; column += 1) headers.push(columnName(column))
  const lines = [headers.join('\t')]
  for (const entry of kept) {
    const values = [String(entry.number)]
    for (let column = 1; column <= stats.columns; column += 1) values.push(cellText(entry.row[column - 1]))
    lines.push(values.join('\t').replace(/\s+$/, ''))
  }
  return { text: lines.join('\n'), truncated: stats.populatedRows > kept.length }
}

function workbookInventory(sheets: Sheet[]): string {
  if (sheets.length === 0) return '### Workbook\n(no worksheets)'
  const lines = [`### Workbook (${sheets.length} sheets)`]
  for (const [index, sheet] of sheets.entries()) {
    const stats = sheetStats(sheet.data)
    const usedRange = stats.firstRow !== undefined && stats.firstColumn !== undefined && stats.lastRow !== undefined && stats.lastColumn !== undefined
      ? `${columnName(stats.firstColumn)}${stats.firstRow}:${columnName(stats.lastColumn)}${stats.lastRow}`
      : 'empty'
    lines.push(`${index + 1}. ${sheet.sheet} — used ${usedRange}; ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells`)
  }
  lines.push('Use sheet with optional cell_range to read only the worksheet region needed for the task.')
  return lines.join('\n')
}

function selectedSheet(sheets: Sheet[], index: number): Sheet {
  if (index < 1 || index > sheets.length) {
    const available = sheets.map((sheet, i) => `${i + 1}. ${sheet.sheet}`).join(', ')
    throw new Error(`sheet ${index} out of range: workbook has ${sheets.length} sheet(s) — ${available}`)
  }
  return sheets[index - 1]
}

function isExtractedXmlPart(name: string): boolean {
  // Keep this in lockstep with read-excel-file's filterZipArchiveEntry().
  return name.endsWith('.xml') || name.endsWith('.xml.rels')
}

function assertSafeXlsxArchive(bytes: Uint8Array): void {
  const members = zipMembers(bytes)
  if (members === null) throw new Error('cannot unpack XLSX safely: invalid, unsupported, or over-complex ZIP central directory')

  let extractedParts = 0
  let extractedBytes = 0
  for (const member of members) {
    if (member.nameBytes > MAX_XLSX_MEMBER_NAME_BYTES) {
      throw new Error(`cannot unpack XLSX safely: member name is ${member.nameBytes} bytes (limit ${MAX_XLSX_MEMBER_NAME_BYTES})`)
    }
    if (!isExtractedXmlPart(member.name)) continue
    extractedParts += 1
    if (extractedParts > MAX_XLSX_XML_PARTS) {
      throw new Error(`cannot unpack XLSX safely: too many XML parts (limit ${MAX_XLSX_XML_PARTS})`)
    }
    if (member.originalSize > MAX_XLSX_XML_PART_BYTES) {
      throw new Error(
        `cannot unpack XLSX safely: XML part "${member.name}" declares ${member.originalSize} bytes ` +
        `(limit ${MAX_XLSX_XML_PART_BYTES})`
      )
    }
    extractedBytes += member.originalSize
    if (extractedBytes > MAX_TOTAL_XLSX_XML_BYTES) {
      throw new Error(
        `cannot unpack XLSX safely: XML parts declare ${extractedBytes} bytes in total ` +
        `(limit ${MAX_TOTAL_XLSX_XML_BYTES})`
      )
    }
  }
}

/** Parse and validate a workbook once so callers can project many sheets. */
export async function parseXlsxWorkbook(bytes: Uint8Array): Promise<XlsxWorkbook> {
  assertSafeXlsxArchive(bytes)
  // The universal entry uses fflate's central-directory sizes. That makes the
  // preflight limits above authoritative for allocations. The Node entry uses
  // streaming local-header sizes, so a central-only preflight would not close
  // the local/central mismatch case.
  const input = new Uint8Array(bytes).buffer
  return readXlsxFile(input)
}

/** Project an already parsed workbook without decompressing it again. */
export function projectXlsx(sheets: XlsxWorkbook, options: XlsxParseOptions): string {
  if (options.cellRange !== undefined && options.sheet === undefined) {
    throw new Error('cell_range requires sheet: list the workbook, then select a worksheet and range')
  }
  if (options.listOnly === true) return workbookInventory(sheets)

  if (options.sheet !== undefined) {
    const sheet = selectedSheet(sheets, options.sheet)
    const stats = sheetStats(sheet.data)
    if (options.cellRange !== undefined) {
      const range = parseCellRange(options.cellRange)
      return [
        `### Sheet ${options.sheet}/${sheets.length}: ${sheet.sheet} — range ${range.normalized}`,
        `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells in worksheet`,
        rowsToCoordinateText(sheet.data, range)
      ].join('\n\n')
    }
    const projection = automaticRowsToText(sheet.data, Math.max(options.sheetRowLimit, stats.populatedRows))
    return [
      `### Sheet ${options.sheet}/${sheets.length}: ${sheet.sheet}`,
      `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells; ${stats.columns} columns`,
      projection.text
    ].join('\n\n')
  }

  const maxSheets = options.maxSheets ?? 5
  const parts: string[] = []
  let omittedSheets = 0
  for (const [index, sheet] of sheets.entries()) {
    if (index >= maxSheets) {
      omittedSheets += 1
      continue
    }
    const stats = sheetStats(sheet.data)
    const projection = automaticRowsToText(sheet.data, options.sheetRowLimit)
    parts.push([
      `### Sheet ${index + 1}/${sheets.length}: ${sheet.sheet}`,
      `Detected values: ${stats.populatedRows} populated rows; ${stats.nonEmptyCells} non-empty cells; ${stats.columns} columns`,
      projection.text,
      ...(projection.truncated
        ? [`… truncated: showing ${options.sheetRowLimit}/${stats.populatedRows} populated rows; call with sheet: ${index + 1}`]
        : [])
    ].join('\n\n'))
  }
  if (omittedSheets > 0) parts.push(`… ${omittedSheets} more sheets omitted; call list_sheets first`)
  return parts.join('\n\n')
}

export async function parseXlsx(bytes: Uint8Array, options: XlsxParseOptions): Promise<string> {
  return projectXlsx(await parseXlsxWorkbook(bytes), options)
}
