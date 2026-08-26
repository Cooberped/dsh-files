// Parser-output -> retrieval block projection. This layer intentionally treats
// src/parse/* as a stable black box: retrieval can be A/B tested independently
// before any parser or richer block-IR redesign is considered.

import { createHash } from 'node:crypto'
import type { DocumentFormat } from '../detect.ts'
import { parseDocument } from '../parse/index.ts'

export interface DocumentDescriptor {
  id: string
  path: string
  format: DocumentFormat
  version: string
}

export interface DocumentBlock {
  id: string
  documentId: string
  version: string
  ordinal: number
  coordinate: string
  heading: string
  text: string
}

export interface BlockBuildOptions {
  blockChars: number
  maxBlocks: number
  signal?: AbortSignal
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('document indexing aborted')
}

function blockId(document: DocumentDescriptor, coordinate: string, ordinal: number, text: string): string {
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
    .digest('hex')
}

function headingFromLines(lines: string[], fallback: string): string {
  const value = lines.find((line) => line.trim() !== '')?.trim() ?? fallback
  return value.length > 160 ? `${value.slice(0, 157)}…` : value
}

interface TextChunk {
  startLine: number
  endLine: number
  text: string
}

function splitLongLine(line: string, maxChars: number): string[] {
  const chars = Array.from(line)
  if (chars.length <= maxChars) return [line]
  const output: string[] = []
  for (let offset = 0; offset < chars.length; offset += maxChars) {
    output.push(chars.slice(offset, offset + maxChars).join(''))
  }
  return output
}

function chunkLines(value: string, maxChars: number): TextChunk[] {
  const source = value.split(/\r?\n/u)
  const expanded: Array<{ line: number; value: string }> = []
  for (const [index, line] of source.entries()) {
    for (const part of splitLongLine(line, maxChars)) expanded.push({ line: index + 1, value: part })
  }
  const output: TextChunk[] = []
  let current: Array<{ line: number; value: string }> = []
  let size = 0
  const flush = () => {
    if (current.length === 0) return
    output.push({
      startLine: current[0].line,
      endLine: current.at(-1)!.line,
      text: current.map((entry) => entry.value).join('\n').trim()
    })
    current = []
    size = 0
  }
  for (const entry of expanded) {
    const added = entry.value.length + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && size + added > maxChars) flush()
    current.push(entry)
    size += entry.value.length + (current.length > 1 ? 1 : 0)
  }
  flush()
  return output.filter((entry) => entry.text !== '')
}

function appendBlock(
  output: DocumentBlock[],
  document: DocumentDescriptor,
  coordinate: string,
  heading: string,
  text: string,
  maxBlocks: number
): void {
  if (output.length >= maxBlocks) {
    throw new Error(`document produced more than ${maxBlocks} retrieval blocks; narrow the document or raise retrievalMaxBlocksPerDocument`)
  }
  const ordinal = output.length + 1
  output.push({
    id: blockId(document, coordinate, ordinal, text),
    documentId: document.id,
    version: document.version,
    ordinal,
    coordinate,
    heading,
    text
  })
}

function genericBlocks(
  text: string,
  document: DocumentDescriptor,
  output: DocumentBlock[],
  options: BlockBuildOptions
): void {
  for (const chunk of chunkLines(text, options.blockChars)) {
    checkAborted(options.signal)
    const coordinate = chunk.startLine === chunk.endLine
      ? `line:${chunk.startLine}`
      : `lines:${chunk.startLine}-${chunk.endLine}`
    appendBlock(
      output,
      document,
      coordinate,
      headingFromLines(chunk.text.split('\n'), document.path),
      chunk.text,
      options.maxBlocks
    )
  }
}

async function pdfBlocks(
  bytes: Uint8Array,
  document: DocumentDescriptor,
  output: DocumentBlock[],
  options: BlockBuildOptions
): Promise<void> {
  const text = await parseDocument(bytes, 'pdf', { sheetRowLimit: 1 })
  // parsePdf joins pages with exactly one blank line. Empty pages remain empty
  // array entries when split on the exact separator, preserving page numbers.
  const pages = text.split('\n\n')
  for (const [pageIndex, page] of pages.entries()) {
    checkAborted(options.signal)
    const chunks = chunkLines(page, options.blockChars)
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const base = `page:${pageIndex + 1}`
      const coordinate = chunks.length === 1 ? base : `${base},lines:${chunk.startLine}-${chunk.endLine}`
      appendBlock(
        output,
        document,
        coordinate,
        headingFromLines(chunk.text.split('\n'), `Page ${pageIndex + 1}`),
        chunk.text,
        options.maxBlocks
      )
    }
  }
}

async function pptxBlocks(
  bytes: Uint8Array,
  document: DocumentDescriptor,
  output: DocumentBlock[],
  options: BlockBuildOptions
): Promise<void> {
  const text = await parseDocument(bytes, 'pptx', { sheetRowLimit: 1 })
  const markers = [...text.matchAll(/^### Slide (\d+)\n/gmu)]
  if (markers.length === 0) {
    genericBlocks(text, document, output, options)
    return
  }
  for (const [index, marker] of markers.entries()) {
    checkAborted(options.signal)
    const slideNumber = Number(marker[1])
    const start = (marker.index ?? 0) + marker[0].length
    const end = markers[index + 1]?.index ?? text.length
    const body = text.slice(start, end).trim()
    const chunks = chunkLines(body, options.blockChars)
    for (const chunk of chunks) {
      const base = `slide:${slideNumber}`
      const coordinate = chunks.length === 1 ? base : `${base},lines:${chunk.startLine}-${chunk.endLine}`
      appendBlock(
        output,
        document,
        coordinate,
        headingFromLines(chunk.text.split('\n'), `Slide ${slideNumber}`),
        chunk.text,
        options.maxBlocks
      )
    }
  }
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

interface WorkbookSheet {
  index: number
  name: string
}

function parseWorkbookInventory(value: string): WorkbookSheet[] {
  const countMatch = /^### Workbook \((\d+) sheets\)/u.exec(value)
  if (countMatch === null) throw new Error('cannot index XLSX: parser returned an invalid workbook inventory')
  const count = Number(countMatch[1])
  const sheets: WorkbookSheet[] = []
  for (const line of value.split('\n')) {
    const match = /^(\d+)\. (.+) — used /u.exec(line)
    if (match !== null) sheets.push({ index: Number(match[1]), name: match[2].normalize('NFC') })
  }
  if (sheets.length !== count) {
    throw new Error(`cannot index XLSX: inventory declared ${count} sheets but described ${sheets.length}`)
  }
  return sheets
}

function renderSpreadsheetRow(columns: string[], headerValues: string[], values: string[], rowNumber: number): string {
  const output = [`row ${rowNumber}`]
  for (let index = 0; index < columns.length; index += 1) {
    const value = values[index] ?? ''
    const label = headerValues[index]?.trim()
    const key = label === undefined || label === '' ? columns[index] : `${columns[index]} (${label})`
    if (value !== '') output.push(`${key}: ${value}`)
  }
  return output.join('\n')
}

async function xlsxBlocks(
  bytes: Uint8Array,
  document: DocumentDescriptor,
  output: DocumentBlock[],
  options: BlockBuildOptions
): Promise<void> {
  const inventory = await parseDocument(bytes, 'xlsx', { sheetRowLimit: 1, listOnly: true })
  const sheets = parseWorkbookInventory(inventory)
  for (const sheet of sheets) {
    checkAborted(options.signal)
    // Selecting one sheet asks the existing parser for all populated rows; no
    // parser implementation or default read_document path is changed here.
    const projection = await parseDocument(bytes, 'xlsx', {
      sheetRowLimit: Number.MAX_SAFE_INTEGER,
      maxSheets: sheets.length,
      sheet: sheet.index
    })
    const lines = projection.split('\n')
    const headerIndex = lines.findIndex((line) => line === 'row' || line.startsWith('row\t'))
    if (headerIndex < 0) continue
    const columns = lines[headerIndex].split('\t').slice(1)
    const rows: Array<{ rowNumber: number; values: string[] }> = []
    for (const line of lines.slice(headerIndex + 1)) {
      if (line.trim() === '' || line.startsWith('… truncated:')) continue
      const cells = line.split('\t')
      const rowNumber = Number(cells.shift())
      if (!Number.isInteger(rowNumber) || rowNumber < 1) continue
      rows.push({ rowNumber, values: cells })
    }
    // The first row is often a title merged across columns. Prefer the first
    // row with at least two populated cells as the structural header; fall
    // back to the first populated row for single-column sheets.
    const headerValues = (
      rows.find((row) => row.values.filter((value) => value.trim() !== '').length >= 2) ?? rows[0]
    )?.values ?? []
    for (const { rowNumber, values } of rows) {
      const lastColumn = columnName(Math.max(columns.length, values.length, 1))
      const coordinate = `${sheet.name}!A${rowNumber}:${lastColumn}${rowNumber}`
      const columnHeading = columns
        .map((column, index) => {
          const label = headerValues[index]?.trim()
          return label === undefined || label === '' ? column : `${column} ${label}`
        })
        .join(' · ')
      const heading = `${sheet.name} · ${coordinate} · ${columnHeading}`
      const rendered = renderSpreadsheetRow(columns, headerValues, values, rowNumber)
      for (const [partIndex, part] of splitLongLine(rendered, options.blockChars).entries()) {
        appendBlock(
          output,
          document,
          partIndex === 0 ? coordinate : `${coordinate},part:${partIndex + 1}`,
          heading,
          part,
          options.maxBlocks
        )
      }
    }
  }
}

/** Build stable, versioned blocks without changing any parser implementation. */
export async function buildDocumentBlocks(
  bytes: Uint8Array,
  document: DocumentDescriptor,
  options: BlockBuildOptions
): Promise<DocumentBlock[]> {
  checkAborted(options.signal)
  const output: DocumentBlock[] = []
  if (document.format === 'pdf') {
    await pdfBlocks(bytes, document, output, options)
  } else if (document.format === 'pptx') {
    await pptxBlocks(bytes, document, output, options)
  } else if (document.format === 'xlsx') {
    await xlsxBlocks(bytes, document, output, options)
  } else {
    const text = await parseDocument(bytes, document.format, { sheetRowLimit: 1 })
    genericBlocks(text, document, output, options)
  }
  checkAborted(options.signal)
  return output
}
