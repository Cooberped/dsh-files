import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_FIXTURE_DIR = join(HERE, 'fixtures', 'generated')
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z')

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function addZipText(zip, path, value) {
  zip.file(path, value, { date: FIXED_DATE, createFolders: false })
}

async function zipBytes(zip) {
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })
}

async function makePdf() {
  const pdf = await PDFDocument.create()
  pdf.setTitle('Synthetic Atlas Process Performance Benchmark')
  pdf.setAuthor('dsh-files benchmark generator')
  pdf.setSubject('Synthetic-only retrieval fixture')
  pdf.setProducer('dsh-files deterministic fixture')
  pdf.setCreator('dsh-files deterministic fixture')
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const pages = [
    [
      'SYNTHETIC ONLY - Project Atlas Process Performance Kickoff',
      'Scope: demonstrate local document retrieval without real HR data.',
      'The benchmark joins PDF, DOCX and XLSX evidence.'
    ],
    [
      'Rule R-42',
      'Q3 people-process on-time target is 95 percent.',
      'The canonical workbook metric is MET-HR-02.'
    ],
    [
      'Control note',
      'MET-HR-01 has a 90 percent target and is a deliberate distractor.',
      'No Q4 budget target is defined in this fixture.'
    ]
  ]
  for (const [index, lines] of pages.entries()) {
    const page = pdf.addPage([612, 792])
    page.drawText(`Page ${index + 1}`, { x: 48, y: 744, size: 11, font })
    for (const [lineIndex, line] of lines.entries()) {
      page.drawText(line, { x: 48, y: 700 - lineIndex * 28, size: lineIndex === 0 ? 15 : 12, font })
    }
  }
  return pdf.save({ useObjectStreams: false })
}

async function makeDocx() {
  const zip = new JSZip()
  addZipText(zip, '[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`)
  addZipText(zip, '_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  addZipText(zip, 'word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>合成会议纪要（仅测试）</w:t></w:r></w:p>
    <w:p><w:r><w:t>会议编号：AX-17。</w:t></w:r></w:p>
    <w:p><w:r><w:t>证据链：PDF 第 2 页规则 R-42 → 隐藏映射 → 指标总览 F4。</w:t></w:r></w:p>
    <w:p><w:r><w:t>会议决定：Q3 人力流程及时率目标采用 95%，指标 MET-HR-02。</w:t></w:r></w:p>
    <w:p><w:r><w:t>绩效流程是干扰词，DISTRACTOR-REVERSED 不应替代精确短语“流程绩效”。</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>行动项</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>负责人</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>AX-17</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Synthetic HRBP</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>MET-HR-02</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`)
  addZipText(zip, 'word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>SYNTHETIC BENCHMARK</w:t></w:r></w:p></w:hdr>`)
  return zipBytes(zip)
}

function inlineCell(ref, value) {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
}

function row(number, cells) {
  return `<row r="${number}">${cells.join('')}</row>`
}

function worksheetXml(dimension, rows, extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetData>${rows.join('')}</sheetData>
  ${extra}
</worksheet>`
}

async function makeXlsx() {
  const zip = new JSZip()
  const sheets = [
    { name: '指标总览', target: 'sheet1.xml' },
    { name: '流程域分工', target: 'sheet2.xml' },
    { name: '隐藏映射', target: 'sheet3.xml', state: 'hidden' },
    { name: '稀疏数据', target: 'sheet4.xml' },
    { name: '顺序干扰', target: 'sheet5.xml' }
  ]
  const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  addZipText(zip, '[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${overrides}
</Types>`)
  addZipText(zip, '_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
  const sheetTags = sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${i + 1}"/>`).join('')
  addZipText(zip, 'xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`)
  const rels = sheets.map((sheet, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${sheet.target}"/>`).join('')
  addZipText(zip, 'xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)

  addZipText(zip, 'xl/worksheets/sheet1.xml', worksheetXml('A1:F5', [
    row(1, [inlineCell('A1', '合成流程绩效指标（仅测试）')]),
    row(2, ['指标ID', 'L1指标', 'L2指标', '口径', '数据源', 'Q3目标'].map((value, i) => inlineCell(`${String.fromCharCode(65 + i)}2`, value))),
    row(3, [inlineCell('A3', 'MET-HR-01'), inlineCell('B3', '人才供给'), inlineCell('C3', '关键岗位到岗及时率'), inlineCell('D3', '按期到岗数/计划到岗数'), inlineCell('E3', 'HRIS'), inlineCell('F3', '90%')]),
    row(4, [inlineCell('A4', 'MET-HR-02'), inlineCell('B4', '流程绩效'), inlineCell('C4', '人力流程及时率'), inlineCell('D4', '按期完成流程数/到期流程数'), inlineCell('E4', 'HRIS'), inlineCell('F4', '95%')]),
    row(5, [inlineCell('A5', 'MET-TAX-01'), inlineCell('B5', '税务合规'), inlineCell('C5', '税票处理准确率'), inlineCell('D5', '准确处理数/处理总数'), inlineCell('E5', 'ERP'), inlineCell('F5', '99%')])
  ], '<mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>'))

  addZipText(zip, 'xl/worksheets/sheet2.xml', worksheetXml('A1:D3', [
    row(1, [inlineCell('A1', '流程域'), inlineCell('B1', '责任角色'), inlineCell('C1', '指标ID'), inlineCell('D1', 'CrossRef')]),
    row(2, [inlineCell('A2', '人力'), inlineCell('B2', 'Synthetic HRBP'), inlineCell('C2', 'MET-HR-02'), inlineCell('D2', 'AX-17')]),
    row(3, [inlineCell('A3', 'IPD'), inlineCell('B3', 'Synthetic PMO'), inlineCell('C3', 'MET-IPD-01'), inlineCell('D3', 'Q3-IPD')])
  ]))

  addZipText(zip, 'xl/worksheets/sheet3.xml', worksheetXml('A1:C2', [
    row(1, [inlineCell('A1', '规则'), inlineCell('B1', '行动项'), inlineCell('C1', '指标ID')]),
    row(2, [inlineCell('A2', 'R-42'), inlineCell('B2', 'AX-17'), inlineCell('C2', 'MET-HR-02')])
  ]))

  addZipText(zip, 'xl/worksheets/sheet4.xml', worksheetXml('A1:Z200', [
    row(1, [inlineCell('A1', '稀疏结构测试')]),
    row(200, [inlineCell('Z200', 'SPARSE-ANCHOR-200')])
  ]))

  addZipText(zip, 'xl/worksheets/sheet5.xml', worksheetXml('A1:B2', [
    row(1, [inlineCell('A1', '顺序干扰'), inlineCell('B1', '标记')]),
    row(2, [inlineCell('A2', '绩效流程'), inlineCell('B2', 'DISTRACTOR-REVERSED')])
  ]))
  return zipBytes(zip)
}

export async function generateFixtures(outputDir = DEFAULT_FIXTURE_DIR) {
  await mkdir(outputDir, { recursive: true })
  const docxName = '流程绩效-Café会议纪要.docx'
  const docxNfdAlias = docxName.normalize('NFD')
  const docxBytes = await makeDocx()
  const outputs = [
    ['atlas-kickoff.pdf', await makePdf()],
    [docxName, docxBytes],
    ['atlas-metrics.xlsx', await makeXlsx()]
  ]
  for (const [name, bytes] of outputs) await writeFile(join(outputDir, name), bytes)
  // On normalization-sensitive filesystems this creates a distinct alias; on
  // macOS APFS it resolves to the same canonical file. Either way, callers can
  // open the exact NFD path a Finder drag may expose.
  if (docxNfdAlias !== docxName) await writeFile(join(outputDir, docxNfdAlias), docxBytes)
  return outputs.map(([name, bytes]) => ({ name, bytes: bytes.length }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputs = await generateFixtures()
  process.stdout.write(`${JSON.stringify({ outputDir: DEFAULT_FIXTURE_DIR, outputs }, null, 2)}\n`)
}
