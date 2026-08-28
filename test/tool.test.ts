// Tool-side budget tests: the per-call output character budget is split by
// format so a verbose PDF/DOCX doesn't inflate the model context to the full
// text-window allowance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOutputBudget, defineReadDocumentTool } from '../src/tool.ts'
import { ParseCache } from '../src/cache.ts'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import JSZip from 'jszip'
import {
  buildDocumentBlocks,
  retrievalDocumentVersion,
  type DocumentDescriptor
} from '../src/retrieval/blocks.ts'

function testTool(bytes: Uint8Array, displayPath: string, options: {
  contained?: boolean
  onContains?: () => void
  onStat?: () => void
  onRead?: () => void
} = {}) {
  const root = { targetKey: FsTargetKey('target:workspace-root'), displayPath: '/workspace' }
  const target = { targetKey: FsTargetKey(`target:${displayPath}`), displayPath }
  const fs = {
    resolve: async (path: string) => path === '.' ? root : target,
    contains: (parent: typeof root, child: typeof target) => {
      options.onContains?.()
      return parent.targetKey === root.targetKey && child.targetKey === target.targetKey && options.contained !== false
    },
    stat: async () => {
      options.onStat?.()
      return { version: FsVersion('fs-v1'), type: 'file', size: bytes.length }
    },
    readBytes: async () => {
      options.onRead?.()
      return bytes
    }
  }
  return defineReadDocumentTool(
    { fs, emit: () => undefined },
    {
      readLimit: 800,
      maxFileBytes: 24 * 1024 * 1024,
      sheetRowLimit: 200,
      maxSheets: 12,
      maxOutputChars: 24000
    },
    new ParseCache(8, 8 * 1024 * 1024)
  )
}

function testExec(tool: ReturnType<typeof defineReadDocumentTool>, args: Record<string, unknown>): Promise<unknown> {
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: '/workspace' } } }
  } as unknown as Parameters<typeof tool.execute>[1]
  return tool.execute(args, exec)
}

async function coordinatePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 300]).drawText('PAGE-ONE-ONLY', { x: 50, y: 250, size: 14, font })
  doc.addPage([400, 300]).drawText('PAGE-TWO-TARGET', { x: 50, y: 250, size: 14, font })
  return new Uint8Array(await doc.save())
}

async function coordinatePptx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="300" r:id="rId1"/><p:sldId id="301" r:id="rId2"/></p:sldIdLst>
</p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`)
  const slide = (text: string) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
  zip.file('ppt/slides/slide1.xml', slide('SLIDE-ONE-ONLY'))
  zip.file('ppt/slides/slide2.xml', slide('SLIDE-TWO-TARGET'))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

async function coordinateXlsx(target = 'XLSX-TARGET'): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="O'Brien Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ignore</t></is></c><c r="B1" t="inlineStr"><is><t>Metric</t></is></c><c r="C1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>${target}</t></is></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>`)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('text uses the full base budget', () => {
  assert.equal(formatOutputBudget('text', 24000), 24000)
})

test('xlsx gets three-quarters of the base budget', () => {
  assert.equal(formatOutputBudget('xlsx', 24000), 18000)
})

test('pdf, docx and pptx get half the base budget', () => {
  assert.equal(formatOutputBudget('pdf', 24000), 12000)
  assert.equal(formatOutputBudget('docx', 24000), 12000)
  assert.equal(formatOutputBudget('pptx', 24000), 12000)
})

test('the halving never drops below the floor for a tiny base', () => {
  assert.equal(formatOutputBudget('pdf', 3000), 2000) // Math.max(2000, floor(1500))
  assert.equal(formatOutputBudget('docx', 2000), 2000)
  assert.equal(formatOutputBudget('pptx', 2000), 2000)
  assert.equal(formatOutputBudget('xlsx', 2000), 2000) // floor(1500) clamped to 2000
})

test('read_document expands a versioned PDF page coordinate exactly', async () => {
  const bytes = await coordinatePdf()
  const result = await testExec(testTool(bytes, '/workspace/sample.pdf'), {
    file_path: 'sample.pdf',
    coordinate: 'page:2',
    version: retrievalDocumentVersion(bytes)
  }) as {
    path: string
    version: string
    coordinate: string
    lines: Array<{ text: string }>
  }
  assert.equal(result.path, 'sample.pdf')
  assert.doesNotMatch(JSON.stringify(result), /\/workspace\//u)
  assert.equal(result.version, retrievalDocumentVersion(bytes))
  assert.equal(result.coordinate, 'page:2')
  assert.match(result.lines.map((line) => line.text).join('\n'), /PAGE-TWO-TARGET/)
  assert.doesNotMatch(result.lines.map((line) => line.text).join('\n'), /PAGE-ONE-ONLY/)
})

test('read_document expands a versioned PPTX slide coordinate exactly', async () => {
  const bytes = await coordinatePptx()
  const result = await testExec(testTool(bytes, '/workspace/sample.pptx'), {
    file_path: 'sample.pptx',
    coordinate: 'slide:2',
    version: retrievalDocumentVersion(bytes)
  }) as { coordinate: string; lines: Array<{ text: string }> }
  const text = result.lines.map((line) => line.text).join('\n')
  assert.equal(result.coordinate, 'slide:2')
  assert.match(text, /SLIDE-TWO-TARGET/)
  assert.doesNotMatch(text, /SLIDE-ONE-ONLY/)
})

test('read_document resolves a quoted XLSX Sheet!Range coordinate without list_sheets', async () => {
  const bytes = await coordinateXlsx()
  const result = await testExec(testTool(bytes, '/workspace/sample.xlsx'), {
    file_path: 'sample.xlsx',
    coordinate: "'O''Brien Plan'!B2:C2",
    version: retrievalDocumentVersion(bytes)
  }) as { coordinate: string; sheet: number; lines: Array<{ text: string }> }
  const text = result.lines.map((line) => line.text).join('\n')
  assert.equal(result.coordinate, "'O''Brien Plan'!B2:C2")
  assert.equal(result.sheet, 1)
  assert.match(text, /range B2:C2/)
  assert.match(text, /XLSX-TARGET/)
  assert.match(text, /42/)
  assert.doesNotMatch(text, /ignore/)
})

test('read_document rejects a stale search version before coordinate expansion', async () => {
  const bytes = await coordinatePdf()
  await assert.rejects(
    testExec(testTool(bytes, '/workspace/sample.pdf'), {
      file_path: 'sample.pdf',
      coordinate: 'page:2',
      version: retrievalDocumentVersion(bytes, 'retrieval-v1')
    }),
    /requested version .* current version .* rerun search_documents/
  )
})

test('read_document requires the matching retrieval version for every coordinate', async () => {
  const bytes = await coordinatePdf()
  await assert.rejects(
    testExec(testTool(bytes, '/workspace/sample.pdf'), {
      file_path: 'sample.pdf',
      coordinate: 'page:2'
    }),
    /version is required when coordinate is provided/
  )
})

test('read_document trusts fs containment, not a relative displayPath, for an outside target', async () => {
  const bytes = new TextEncoder().encode('private')
  let containsCalls = 0
  let statCalls = 0
  let readCalls = 0
  let error: unknown
  try {
    await testExec(testTool(bytes, 'secret.txt', {
      contained: false,
      onContains: () => { containsCalls += 1 },
      onStat: () => { statCalls += 1 },
      onRead: () => { readCalls += 1 }
    }), {
      file_path: '/Users/private-account/secret.txt'
    })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof Error)
  assert.equal(containsCalls, 1)
  assert.equal(statCalls, 0)
  assert.equal(readCalls, 0)
  assert.match(error.message, /outside the active session workspace/)
  assert.doesNotMatch(error.message, /\/Users\/private-account/u)
})

test('read_document fails closed when a contained remote target has no reusable workspace path', async () => {
  const remote = 'remote://private-host/tenant/document.txt'
  const bytes = new TextEncoder().encode('private')
  let error: unknown
  try {
    await testExec(testTool(bytes, remote), { file_path: remote })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof Error)
  assert.match(error.message, /cannot be represented as a reusable workspace-relative path/)
  assert.doesNotMatch(error.message, /private-host|tenant|document\.txt/u)
})

test('read_document expands a long-line tail block by Unicode code-point range', async () => {
  const source = `${'😀'.repeat(32)}TARGET-TAIL`
  const bytes = new TextEncoder().encode(source)
  const descriptor: DocumentDescriptor = {
    id: 'text-tail',
    path: 'tail.txt',
    format: 'text',
    version: retrievalDocumentVersion(bytes)
  }
  const blocks = await buildDocumentBlocks(bytes, descriptor, { blockChars: 16, maxBlocks: 20 })
  const tail = blocks.find((block) => block.text.includes('TARGET-TAIL'))
  assert.ok(tail)
  assert.equal(tail.coordinate, 'line:1,chars:33-43')
  const result = await testExec(testTool(bytes, 'tail.txt'), {
    file_path: 'tail.txt',
    coordinate: tail.coordinate,
    version: descriptor.version
  }) as { path: string; offset: number; lines: Array<{ number: number; text: string }> }
  assert.equal(result.path, 'tail.txt')
  assert.equal(result.offset, 1)
  assert.deepEqual(result.lines, [{ number: 1, text: tail.text }])
})

test('XLSX long-row blocks replace legacy part coordinates with reversible character ranges', async () => {
  const bytes = await coordinateXlsx(`${'H'.repeat(96)}TARGET-TAIL`)
  const descriptor: DocumentDescriptor = {
    id: 'xlsx-tail',
    path: 'tail.xlsx',
    format: 'xlsx',
    version: retrievalDocumentVersion(bytes)
  }
  const blocks = await buildDocumentBlocks(bytes, descriptor, { blockChars: 32, maxBlocks: 100 })
  assert.equal(blocks.some((block) => block.coordinate.includes(',part:')), false)
  const tail = blocks.find((block) => block.text.includes('TARGET-TAIL'))
  assert.ok(tail)
  assert.match(tail.coordinate, /^'O''Brien Plan'!A2:C2,chars:\d+-\d+$/u)
  const result = await testExec(testTool(bytes, '/workspace/tail.xlsx'), {
    file_path: 'tail.xlsx',
    coordinate: tail.coordinate,
    version: descriptor.version
  }) as { coordinate: string; sheet: number; lines: Array<{ text: string }> }
  assert.equal(result.coordinate, tail.coordinate)
  assert.equal(result.sheet, 1)
  assert.equal(result.lines.map((line) => line.text).join('\n'), tail.text)
  assert.match(tail.text, /TARGET-TAIL/)

  await assert.rejects(
    testExec(testTool(bytes, '/workspace/tail.xlsx'), {
      file_path: 'tail.xlsx',
      coordinate: "'O''Brien Plan'!A2:C2,part:2",
      version: descriptor.version
    }),
    /legacy XLSX part coordinate .* not safely reversible/
  )
})

// 回归：#5 —— readBytes 的 maxBytes 是整个文件上限（stat 超限即 FS_TOO_LARGE，
// 不截断），旧实现先按 HEAD_SNIFF_BYTES(64 KiB) 嗅探头部，任何更大的文件都会
// 在嗅探阶段被拒。现在一次读满 maxFileBytes，头部从缓冲截取。
test('read_document reads files larger than 64 KiB (head sniff no longer caps the read)', async () => {
  const SIZE = 128 * 1024
  const maxFileBytes = 24 * 1024 * 1024
  const readCaps: number[] = []
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-big'), displayPath: '/workspace/big.txt' }),
    contains: () => true,
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: SIZE }),
    readBytes: async (_target: unknown, _signal: unknown, maxBytes: number) => {
      readCaps.push(maxBytes)
      // 复刻 @deepseek-ai/dsh-fs 契约：maxBytes 是整体上限，超限即抛错。
      if (maxBytes < SIZE) throw new FsError(`bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      return new Uint8Array(SIZE).fill(0x61) // 全 'a'，UTF-8 文本
    }
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    {
      readLimit: 800,
      maxFileBytes,
      sheetRowLimit: 200,
      maxSheets: 5,
      maxOutputChars: 24000
    },
    new ParseCache(4, 1024 * 1024)
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  const result = (await tool.execute({ file_path: 'big.txt' }, exec)) as {
    format: string
    lines: Array<{ number: number; text: string }>
    totalLines: number
  }
  assert.equal(result.format, 'text')
  assert.ok(result.lines.length > 0)
  // 只读一次，且上限是 maxFileBytes 而非 64 KiB。
  assert.deepEqual(readCaps, [maxFileBytes])
})

test('read_document still rejects files over maxFileBytes with FS_TOO_LARGE', async () => {
  const maxFileBytes = 1024
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-over'), displayPath: '/workspace/over.bin' }),
    contains: () => true,
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: 2048 }),
    readBytes: async () => {
      throw new Error('must not be reached')
    }
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 800, maxFileBytes, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 },
    new ParseCache(4, 1024 * 1024)
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  await assert.rejects(
    tool.execute({ file_path: 'over.bin' }, exec),
    (err: unknown) => err instanceof FsError && err.code === 'FS_TOO_LARGE'
  )
})
