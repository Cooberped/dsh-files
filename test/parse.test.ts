// Parser tests against programmatically generated samples: PDF via pdf-lib,
// DOCX/XLSX via JSZip. Verifies text extraction, sheet row limits, line
// windows and BOM-aware text decoding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { parsePdf } from '../src/parse/pdf.ts'
import { parseDocx } from '../src/parse/docx.ts'
import { parseXlsx, parseXlsxWorkbook, projectXlsx } from '../src/parse/xlsx.ts'
import { parsePptx } from '../src/parse/pptx.ts'
import { parseDocument } from '../src/parse/index.ts'
import { decodeText, windowLines } from '../src/parse/text.ts'

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText(text, { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

/** 两个分离的 text run（x 坐标不同），模拟 PDF 常见的单词拆分。 */
async function makeSplitRunPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText('Hello', { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  page.drawText('world', { x: 110, y: 250, size: 14, font, color: rgb(0, 0, 0) })
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

function patchCentralOriginalSizes(bytes: Uint8Array, declaredSizes: Record<string, number>): Uint8Array {
  const output = Uint8Array.from(bytes)
  const pending = new Set(Object.keys(declaredSizes))
  const readU16 = (offset: number): number => output[offset] | (output[offset + 1] << 8)
  const writeU32 = (offset: number, value: number): void => {
    output[offset] = value & 0xff
    output[offset + 1] = (value >>> 8) & 0xff
    output[offset + 2] = (value >>> 16) & 0xff
    output[offset + 3] = (value >>> 24) & 0xff
  }
  for (let offset = 0; offset + 46 <= output.length && pending.size > 0; offset += 1) {
    if (
      output[offset] !== 0x50 || output[offset + 1] !== 0x4b ||
      output[offset + 2] !== 0x01 || output[offset + 3] !== 0x02
    ) continue
    const nameLength = readU16(offset + 28)
    const extraLength = readU16(offset + 30)
    const commentLength = readU16(offset + 32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > output.length) continue
    const name = new TextDecoder().decode(output.subarray(offset + 46, offset + 46 + nameLength))
    const declaredSize = declaredSizes[name]
    if (declaredSize !== undefined) {
      writeU32(offset + 24, declaredSize)
      pending.delete(name)
    }
    offset = next - 1
  }
  assert.deepEqual([...pending], [], `missing central-directory fixtures: ${[...pending].join(', ')}`)
  return output
}

async function makePptx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="300" r:id="rId7"/><p:sldId id="301" r:id="rId3"/></p:sldIdLst>
</p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`)
  const slide = (title: string, body: string) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
    <a:p><a:r><a:t>${body}</a:t></a:r><a:br/><a:r><a:t>After break</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
  zip.file('ppt/slides/slide1.xml', slide('Second logical slide', 'STRAT-02'))
  zip.file('ppt/slides/slide2.xml', slide('First logical slide', 'STRAT-01'))
  zip.file('ppt/slides/_rels/slide2.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide4.xml"/>
</Relationships>`)
  zip.file('ppt/notesSlides/notesSlide4.xml', `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note N-17</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('pdf text extraction', async () => {
  const pdf = await makePdf('Hello PDF world')
  const text = await parsePdf(pdf)
  assert.match(text, /Hello PDF world/)
})

test('pdf separated text runs get a space inserted', async () => {
  // 两个 x 坐标不同的 text run：直接拼接会得到 "Helloworld"，
  // 间隙检测应补空格。
  const text = await parsePdf(await makeSplitRunPdf())
  assert.match(text, /Hello world/)
})

test('docx text extraction', async () => {
  const text = await parseDocx(await makeDocx())
  assert.match(text, /First paragraph/)
  assert.match(text, /Second paragraph/)
})

test('pptx follows presentation order and includes speaker notes', async () => {
  const text = await parsePptx(await makePptx())
  assert.match(text, /^### Slide 1\nFirst logical slide/m)
  assert.ok(text.indexOf('First logical slide') < text.indexOf('Second logical slide'))
  assert.match(text, /STRAT-01\nAfter break/)
  assert.match(text, /#### Speaker notes\nSpeaker note N-17/)
  assert.match(text, /### Slide 2\nSecond logical slide/)
})

test('pptx follows relationship targets with legal nonstandard part names', async () => {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="300" r:id="rCustom"/></p:sldIdLst>
</p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="custom/scene-A.xml"/>
</Relationships>`)
  zip.file('ppt/custom/scene-A.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Custom relationship slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`)
  zip.file('ppt/custom/_rels/scene-A.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="notes/note-A.xml"/>
</Relationships>`)
  zip.file('ppt/custom/notes/note-A.xml', `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Custom relationship note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`)
  const text = await parsePptx(new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' })))
  assert.match(text, /^### Slide 1\nCustom relationship slide/m)
  assert.match(text, /#### Speaker notes\nCustom relationship note/)
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
  assert.match(limited, /### Sheet 1\/1:/)
  assert.match(limited, /truncated/)
})

test('xlsx rejects a hostile central-directory expansion size before decoding', async () => {
  const bytes = await makeXlsx([['safe']])
  const hostile = patchCentralOriginalSizes(bytes, {
    'xl/worksheets/sheet1.xml': 0xfffffff0
  })
  await assert.rejects(
    parseXlsx(hostile, { sheetRowLimit: 10 }),
    /cannot unpack XLSX safely.*sheet1\.xml.*declares 4294967280 bytes/
  )
})

test('xlsx workbook parsing can be reused for multiple projections', async () => {
  const workbook = await parseXlsxWorkbook(await makeXlsx([
    ['Name', 'Score'],
    ['Alice', 42]
  ]))
  assert.equal(workbook.length, 1)
  assert.match(projectXlsx(workbook, { sheetRowLimit: 10, listOnly: true }), /Workbook \(1 sheets\)/)
  assert.match(projectXlsx(workbook, { sheetRowLimit: 10, sheet: 1 }), /Alice/)
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

async function makeBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([400, 300])
  return new Uint8Array(await doc.save())
}

async function makeMultiSheetXlsx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)
  const sheetXml = (rows: string[], tag: string) =>
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((v, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${v}</t></is></c></row>`).join('') +
    `</sheetData></worksheet>`
  zip.file('xl/worksheets/sheet1.xml', sheetXml(['alpha'], 's1'))
  zip.file('xl/worksheets/sheet2.xml', sheetXml(['beta', 'gamma', 'delta'], 's2'))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('xlsx rejects excessive aggregate XML expansion before decoding', async () => {
  const thirtyMiB = 30 * 1024 * 1024
  const hostile = patchCentralOriginalSizes(await makeMultiSheetXlsx(), {
    '[Content_Types].xml': thirtyMiB,
    'xl/workbook.xml': thirtyMiB,
    'xl/_rels/workbook.xml.rels': thirtyMiB,
    'xl/worksheets/sheet1.xml': thirtyMiB,
    'xl/worksheets/sheet2.xml': thirtyMiB
  })
  await assert.rejects(
    parseXlsx(hostile, { sheetRowLimit: 10 }),
    /cannot unpack XLSX safely.*in total.*limit 134217728/
  )
})

test('xlsx rejects overlong ZIP member names before decoding', async () => {
  const zip = await JSZip.loadAsync(await makeXlsx([['safe']]))
  zip.file(`xl/${'a'.repeat(1100)}.xml`, '<ignored/>')
  const hostile = new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
  await assert.rejects(
    parseXlsx(hostile, { sheetRowLimit: 10 }),
    /cannot unpack XLSX safely: member name is .* bytes \(limit 1024\)/
  )
})

test('scan-only PDFs are flagged instead of returning empty text', async () => {
  const text = await parsePdf(await makeBlankPdf())
  assert.match(text, /没有文本层|扫描/)
})

test('xlsx sheet parameter reads a single sheet in full', async () => {
  const bytes = await makeMultiSheetXlsx()
  // sheet=2 全量读取：sheetRowLimit=1 和 maxSheets=1 都不应截断它。
  const sheet2 = await parseXlsx(bytes, { sheetRowLimit: 1, maxSheets: 1, sheet: 2 })
  assert.match(sheet2, /beta/)
  assert.match(sheet2, /delta/)
  assert.doesNotMatch(sheet2, /alpha/)
  // 默认路径仍受 maxSheets 截断（只读 S1）。
  const merged = await parseXlsx(bytes, { sheetRowLimit: 1, maxSheets: 1 })
  assert.match(merged, /alpha/)
  assert.doesNotMatch(merged, /beta/)
  // 越界 sheet 明确报错。
  await assert.rejects(parseXlsx(bytes, { sheetRowLimit: 1, sheet: 9 }), /out of range/)
})

test('sheet 参数只对 xlsx 有意义，对 pdf/docx/pptx/text 显式报错而非静默忽略', async () => {
  const pdfBytes = await makePdf('sheet n/a') // pdf-lib 标准字体只能编码 WinAnsi/拉丁文本
  for (const [bytes, label] of [
    [pdfBytes, 'pdf'],
    [await makeDocx(), 'docx'],
    [await makePptx(), 'pptx'],
    [new TextEncoder().encode('plain'), 'text']
  ] as const) {
    await assert.rejects(
      parseDocument(bytes, label, { sheetRowLimit: 10, sheet: 2 }),
      /only supported for XLSX/
    )
  }
  // xlsx 仍正常
  const ok = await parseDocument(await makeXlsx([['a']]), 'xlsx', { sheetRowLimit: 10, sheet: 1 })
  assert.match(ok, /a/)
})

test('listOnly returns a workbook structure inventory without leaking cell values', async () => {
  const bytes = await makeMultiSheetXlsx()
  const listed = await parseXlsx(bytes, { sheetRowLimit: 1, listOnly: true })
  assert.match(listed, /Workbook \(2 sheets\)/)
  assert.match(listed, /1\. S1/)
  assert.match(listed, /2\. S2/)
  assert.match(listed, /3 populated rows/)
  assert.match(listed, /3 non-empty cells/)
  // 清单只投影结构统计，不泄露 alpha/beta 单元格内容。
  assert.doesNotMatch(listed, /alpha/)
  assert.doesNotMatch(listed, /beta/)
})

test('listOnly reports the actual non-empty used range', async () => {
  const bytes = await makeXlsx([[''], ['', 'only-value']])
  const listed = await parseXlsx(bytes, { sheetRowLimit: 1, listOnly: true })
  assert.match(listed, /used B2:B2/)
  assert.doesNotMatch(listed, /only-value/)
})

test('cellRange keeps A1 coordinates and requires a selected sheet', async () => {
  const bytes = await makeXlsx([
    ['Name', 'Score', 'Team'],
    ['Alice', 42, 'Red'],
    ['Bob', 7, 'Blue']
  ])
  const selected = await parseXlsx(bytes, { sheetRowLimit: 1, sheet: 1, cellRange: 'B2:C3' })
  assert.match(selected, /range B2:C3/)
  assert.match(selected, /row\tB\tC/)
  assert.match(selected, /2\t42\tRed/)
  assert.match(selected, /3\t7\tBlue/)
  assert.doesNotMatch(selected, /Alice/)
  await assert.rejects(
    parseXlsx(bytes, { sheetRowLimit: 1, cellRange: 'A1:B2' }),
    /cell_range requires sheet/
  )
  await assert.rejects(
    parseXlsx(bytes, { sheetRowLimit: 1, sheet: 1, cellRange: 'B9:A1' }),
    /invalid cell_range/
  )
  await assert.rejects(
    parseXlsx(bytes, { sheetRowLimit: 1, sheet: 1, cellRange: 'A1:XFD1048576' }),
    /at most 100000 cells/
  )
})

async function makeWorkbookWithoutSheet1Xml(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet7.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="First" sheetId="9" r:id="rId7"/><sheet name="Second" sheetId="2" r:id="rId3"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)
  const xml = (value: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`
  zip.file('xl/worksheets/sheet2.xml', xml('RELATION_FIRST_OK'))
  zip.file('xl/worksheets/sheet7.xml', xml('RELATION_SECOND_OK'))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('worksheet relationship mapping works when sheet1.xml does not exist', async () => {
  const bytes = await makeWorkbookWithoutSheet1Xml()
  const inventory = await parseXlsx(bytes, { sheetRowLimit: 10, listOnly: true })
  assert.match(inventory, /1\. First/)
  assert.match(inventory, /2\. Second/)
  assert.match(await parseXlsx(bytes, { sheetRowLimit: 10, sheet: 1 }), /RELATION_FIRST_OK/)
  assert.match(await parseXlsx(bytes, { sheetRowLimit: 10, sheet: 2 }), /RELATION_SECOND_OK/)
})

test('sheet out-of-range error names the available sheets', async () => {
  const bytes = await makeMultiSheetXlsx()
  await assert.rejects(parseXlsx(bytes, { sheetRowLimit: 1, sheet: 9 }), /S1.*S2|S2.*S1/)
})

test('windowLines truncates over-long lines with an explicit marker', () => {
  const w = windowLines('short\n' + 'x'.repeat(50), 1, 10, 20)
  assert.equal(w.lines[0].text, 'short') // 5 chars, fits
  // 剩余预算 15 字符：超长行截断到 15 字符 + 标记。
  assert.match(w.lines[1].text, /^x{15}…\[truncated, 50 chars\]$/)
})

test('windowLines enforces a total character budget across the window', () => {
  // 预算 25：第 1 行 11 字符，剩余 14；第 2 行 11 字符，剩余 3；
  // 第 3 行 13 字符超剩余预算 → 截断到 3 字符 + 标记。
  const w = windowLines('line-one-12\nline-two-12\nline-three-14', 1, 10, 25)
  assert.equal(w.lines.length, 3)
  assert.equal(w.lines[0].text, 'line-one-12')
  assert.equal(w.lines[1].text, 'line-two-12')
  assert.match(w.lines[2].text, /^lin…\[truncated, 13 chars\]$/)
  assert.equal(w.totalLines, 3)
})

test('windowLines reports hidden lines when the budget cuts the window', () => {
  const w = windowLines('a\nb\nc\nd\ne', 1, 10, 3)
  // 预算 3：a/b/c 各 1 字符用尽；第 4 行超预算 → 截断标记行 + 隐藏 1 行。
  assert.equal(w.lines.length, 4)
  assert.match(w.lines[3].text, /truncated, 1 chars/)
  assert.match(w.lines[3].text, /1 more line/)
})

test('empty text decodes as an empty document', () => {
  assert.equal(decodeText(new Uint8Array(0)), '')
  const w = windowLines('', 1, 10)
  assert.equal(w.totalLines, 1)
  assert.deepEqual(w.lines, [{ number: 1, text: '' }])
})

test('utf-16le without BOM decodes as a fallback', () => {
  // 'hi' 的 UTF-16LE（无 BOM）：68 00 69 00。UTF-8/GB18030 解出会带 NUL，
  // 被拒绝后走无 BOM UTF-16 兜底。
  const bytes = new Uint8Array([0x68, 0x00, 0x69, 0x00])
  assert.equal(decodeText(bytes), 'hi')
})
