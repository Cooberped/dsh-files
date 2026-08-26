// Unified document parsing entry: dispatch by sniffed format, keep line
// semantics consistent across parsers.

import type { DocumentFormat } from '../detect.js'
import { parsePdf } from './pdf.ts'
import { parseDocx } from './docx.ts'
import { parseXlsx } from './xlsx.ts'
import { parsePptx } from './pptx.ts'
import { decodeText } from './text.ts'

export interface ParseOptions {
  sheetRowLimit: number
  maxSheets?: number
  /** 1-based；XLSX 专用，指定后读取该 sheet 全量。 */
  sheet?: number
  /** XLSX 专用：盘点 sheet 名、used range 与检测到的值计数，不返回单元格内容。 */
  listOnly?: boolean
  /** XLSX 专用：A1 范围，需要同时指定 sheet。 */
  cellRange?: string
}

export async function parseDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ParseOptions
): Promise<string> {
  // sheet/listOnly 只对 xlsx 有意义：对 PDF/DOCX/text 显式报错，防止调用方
  // 以为 sheet 参数生效而拿到完整（未按 sheet 过滤）内容。
  if ((options.sheet !== undefined || options.listOnly === true || options.cellRange !== undefined) && format !== 'xlsx') {
    throw new Error(`sheet/listOnly/cellRange parameters are only supported for XLSX files (format: ${format})`)
  }
  switch (format) {
    case 'pdf':
      return parsePdf(bytes)
    case 'docx':
      return parseDocx(bytes)
    case 'xlsx':
      return parseXlsx(bytes, options)
    case 'pptx':
      return parsePptx(bytes)
    case 'text': {
      const text = decodeText(bytes)
      if (text === null) {
        throw new Error('cannot decode text file: unsupported encoding (expected UTF-8, UTF-16 or GB18030)')
      }
      return text
    }
  }
}
