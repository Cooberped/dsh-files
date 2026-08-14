// Unified document parsing entry: dispatch by sniffed format, keep line
// semantics consistent across parsers.

import type { DocumentFormat } from '../detect.js'
import { parsePdf } from './pdf.ts'
import { parseDocx } from './docx.ts'
import { parseXlsx } from './xlsx.ts'
import { decodeText } from './text.ts'

export interface ParseOptions {
  sheetRowLimit: number
  maxSheets?: number
}

export async function parseDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ParseOptions
): Promise<string> {
  switch (format) {
    case 'pdf':
      return parsePdf(bytes)
    case 'docx':
      return parseDocx(bytes)
    case 'xlsx':
      return parseXlsx(bytes, options)
    case 'text': {
      const text = decodeText(bytes)
      if (text === null) {
        throw new Error('cannot decode text file: unsupported encoding (expected UTF-8, UTF-16 or GB18030)')
      }
      return text
    }
  }
}
