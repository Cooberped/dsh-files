// Parser tests against programmatically generated samples: PDF via pdf-lib,
// DOCX/XLSX via JSZip. Verifies text extraction, sheet row limits, line
// windows and BOM-aware text decoding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { parsePdf } from '../src/parse/pdf.ts'
import { parseDocx } from '../src/parse/docx.ts'
import { parseXlsx } from '../src/parse/xlsx.ts'
import { decodeText, windowLines } from '../src/parse/text.ts'

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText(text, { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>`

async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', DOCX_XML)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

async function makeXlsx(rows: Array<Array<string | number>>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  const cells = rows
    .map((row, r) => {
      const cols = row
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cols}</row>`
    })
    .join('')
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('pdf text extraction', async () => {
  const pdf = await makePdf('Hello PDF world')
  const text = await parsePdf(pdf)
  assert.match(text, /Hello PDF world/)
})

test('docx text extraction', async () => {
  const text = await parseDocx(await makeDocx())
  assert.match(text, /First paragraph/)
  assert.match(text, /Second paragraph/)
})

test('xlsx text extraction with row limit', async () => {
  const rows: Array<Array<string | number>> = [
    ['Name', 'Score'],
    ['Alice', 42],
    ['Bob', 7]
  ]
  const bytes = await makeXlsx(rows)
  const full = await parseXlsx(bytes, { sheetRowLimit: 10 })
  assert.match(full, /Alice/)
  assert.match(full, /42/)
  // 截断必须显式告知模型：数据行 + sheet 标题 + 截断标记。
  const limited = await parseXlsx(bytes, { sheetRowLimit: 2 })
  assert.match(limited, /Alice/)
  assert.doesNotMatch(limited, /Bob/)
  assert.match(limited, /### Sheet:/)
  assert.match(limited, /已截断/)
})

test('utf-8 text decoding', () => {
  const bytes = new TextEncoder().encode('你好，世界\nline 2')
  assert.equal(decodeText(bytes), '你好，世界\nline 2')
})

test('utf-16le BOM text decoding', () => {
  // 你 = U+4F60, 好 = U+597D, little-endian
  const bytes = new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59])
  assert.equal(decodeText(bytes), '你好')
})

test('windowLines pages without a phantom trailing line', () => {
  const text = 'a\nb\nc\n'
  const w1 = windowLines(text, 1, 2)
  assert.equal(w1.totalLines, 3)
  assert.deepEqual(w1.lines, [
    { number: 1, text: 'a' },
    { number: 2, text: 'b' }
  ])
  const w2 = windowLines(text, 3, 10)
  assert.deepEqual(w2.lines, [{ number: 3, text: 'c' }])
})

test('windowLines clamps offsets past the end', () => {
  const w = windowLines('x\ny', 10, 5)
  assert.equal(w.totalLines, 2)
  assert.deepEqual(w.lines, [])
})
