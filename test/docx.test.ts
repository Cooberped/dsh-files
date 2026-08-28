import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { parseDocx } from '../src/parse/docx.ts'

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

function wordPart(body: string, root = 'document'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:${root}>`
}

async function makeDocx(main: string, optional: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', RELS)
  zip.file('word/document.xml', wordPart(main))
  for (const [name, xml] of Object.entries(optional)) zip.file(name, xml)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('DOCX projection preserves runs, entities, tabs and line breaks while excluding deletions', async () => {
  const bytes = await makeDocx(`
    <w:p>
      <w:r><w:t>Hello &amp; </w:t></w:r>
      <w:del><w:r><w:t>deleted</w:t></w:r></w:del>
      <w:ins><w:r><w:t>kept</w:t><w:tab/><w:t>Tail</w:t><w:br/><w:t>Next</w:t></w:r></w:ins>
    </w:p>`)
  const text = await parseDocx(bytes)
  assert.equal(text, 'Hello & kept\tTail\nNext')
  assert.doesNotMatch(text, /deleted/)
})

test('DOCX projection keeps table rows and cell boundaries', async () => {
  const bytes = await makeDocx(`
    <w:tbl><w:tr>
      <w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>`)
  assert.equal(await parseDocx(bytes), 'A1 / A2\tB')
})

test('DOCX projection labels optional header and footnote parts and reports altChunk omission', async () => {
  const bytes = await makeDocx(
    '<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:altChunk r:id="chunk1"/>',
    {
      'word/header1.xml': wordPart('<w:p><w:r><w:t>Header value</w:t></w:r></w:p>', 'hdr'),
      'word/footnotes.xml': wordPart('<w:p><w:r><w:t>Footnote value</w:t></w:r></w:p>', 'footnotes')
    }
  )
  const text = await parseDocx(bytes)
  assert.match(text, /^Body/m)
  assert.match(text, /### Footnotes\nFootnote value/)
  assert.match(text, /### Header 1\nHeader value/)
  assert.match(text, /altChunk content is not expanded/)
})

test('DOCX projection rejects packages without the main document part', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
  await assert.rejects(parseDocx(bytes), /missing word\/document\.xml/)
})

test('DOCX projection accepts more than 63 legitimate header parts', async () => {
  const optional: Record<string, string> = {}
  for (let index = 1; index <= 64; index += 1) {
    optional[`word/header${index}.xml`] = wordPart(`<w:p><w:r><w:t>H${index}</w:t></w:r></w:p>`, 'hdr')
  }
  const bytes = await makeDocx('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', optional)
  assert.match(await parseDocx(bytes), /### Header 64\nH64/)
})

test('DOCX projection still caps pathological XML part counts', async () => {
  const optional: Record<string, string> = {}
  for (let index = 1; index <= 256; index += 1) {
    optional[`word/header${index}.xml`] = wordPart(`<w:p><w:r><w:t>H${index}</w:t></w:r></w:p>`, 'hdr')
  }
  const bytes = await makeDocx('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', optional)
  await assert.rejects(parseDocx(bytes), /too many relevant XML parts/)
})
