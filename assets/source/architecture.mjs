// Four-layer architecture diagram.
//
// The four columns are a fixed grid: widening one would break the row, so every
// label is checked against its slot and an over-long string fails the build.
// The vision row at the bottom is content-driven, so its boxes and the arrows
// between them are laid out from the measured text.

import { assertFits, boxWidth, esc, slotWidth } from './metrics.mjs'

export const size = { width: 1440, height: 720 }

const FONT =
  'Inter, &quot;PingFang SC&quot;, &quot;Hiragino Sans GB&quot;, &quot;Microsoft YaHei&quot;, ' +
  '&quot;Noto Sans CJK SC&quot;, &quot;Source Han Sans SC&quot;, ui-sans-serif, system-ui, sans-serif'

const COLUMN = { width: 275, height: 330, pitch: 330, padX: 24, itemWidth: 227, itemPadX: 18 }
const COLUMN_THEME = [
  { accent: '#f3c66b', badgeText: '#17202b', item: '#172b40', itemText: '#d8e5ef', footer: '#f3c66b' },
  { accent: '#5bd6c3', badgeText: '#10252a', item: '#153039', itemText: '#d8f1ec', footer: '#5bd6c3' },
  { accent: '#8aa3ff', badgeText: '#162041', item: '#1d2946', itemText: '#e0e7ff', footer: '#9eb1ff' },
  { accent: '#ff8f75', badgeText: '#351a18', item: '#332325', itemText: '#ffe8e2', footer: '#ff9c88' }
]

const VISION = { barWidth: 1265, boxHeight: 58, boxY: 24, padX: 30, arrow: 76, gap: 16, fontSize: 15 }
const VISION_THEME = [
  { fill: '#2c2020', text: '#ff9c88', weight: 700 },
  { fill: '#172b40', text: '#d8e5ef', weight: 400 },
  { fill: '#172b40', text: '#d8e5ef', weight: 400 },
  { fill: '#173529', text: '#d9f1e7', weight: 400 }
]

export function render(t) {
  const columns = t.columns.map((column, index) => {
    const slot = slotWidth(COLUMN.width, COLUMN.padX)
    assertFits(column.name, { fontSize: 20, weight: 700, available: slotWidth(COLUMN.width, 62), where: `architecture:columns[${index}].name` })
    assertFits(column.sub, { fontSize: 14, available: slot, where: `architecture:columns[${index}].sub` })
    assertFits(column.footer, { fontSize: 13, weight: 700, available: slot, where: `architecture:columns[${index}].footer` })
    for (const [i, item] of column.items.entries()) {
      assertFits(item, {
        fontSize: 15,
        available: slotWidth(COLUMN.itemWidth, COLUMN.itemPadX),
        where: `architecture:columns[${index}].items[${i}]`
      })
    }
    return { ...column, x: index * COLUMN.pitch, theme: COLUMN_THEME[index] }
  })

  // Vision row: measure each box, then distribute the slack evenly so the
  // arrows keep equal length whatever the translation does to the labels.
  const boxes = t.vision.map((label, index) => ({
    label,
    width: boxWidth(label, { fontSize: VISION.fontSize, weight: VISION_THEME[index].weight, padX: VISION.padX }),
    theme: VISION_THEME[index]
  }))
  const boxTotal = boxes.reduce((sum, box) => sum + box.width, 0)
  const slack = VISION.barWidth - COLUMN.padX * 2 - boxTotal - VISION.arrow * 3
  if (slack < 0) {
    throw new Error(`architecture: vision row overflows by ${Math.ceil(-slack)}px; shorten a label in content.mjs vision[]`)
  }
  const spacing = slack / 6
  let cursor = COLUMN.padX
  const placed = []
  for (const [index, box] of boxes.entries()) {
    if (index > 0) {
      const arrowStart = cursor + spacing
      placed.push({ arrow: { x: Math.round(arrowStart), width: VISION.arrow } })
      cursor = arrowStart + VISION.arrow + spacing
    }
    placed.push({ box: { ...box, x: Math.round(cursor) } })
    cursor += box.width
  }

  const centerY = VISION.boxY + VISION.boxHeight / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(t.title)}</title>
  <desc id="desc">${esc(t.desc)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#091321"/><stop offset="1" stop-color="#10283a"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity=".23"/></filter>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0l10 5-10 5z" fill="#6d879d"/></marker>
  </defs>
  <rect width="${size.width}" height="${size.height}" rx="32" fill="url(#bg)"/>
  <text x="72" y="72" fill="#f8fbff" font-family="${FONT}" font-size="34" font-weight="760">${esc(t.headline)}</text>
  <text x="72" y="106" fill="#8fa5b8" font-family="${FONT}" font-size="17">${esc(t.subhead)}</text>

  <g transform="translate(72 160)" font-family="${FONT}" filter="url(#shadow)">
${columns
  .map(
    (column, index) => `    <g${column.x === 0 ? '' : ` transform="translate(${column.x})"`}>
      <rect width="${COLUMN.width}" height="${COLUMN.height}" rx="22" fill="#101f31" stroke="#34516b"/>
      <circle cx="34" cy="37" r="16" fill="${column.theme.accent}"/><text x="29" y="43" fill="${column.theme.badgeText}" font-size="16" font-weight="800">${index + 1}</text>
      <text x="62" y="43" fill="#f4f8fb" font-size="20" font-weight="700">${esc(column.name)}</text>
      <text x="${COLUMN.padX}" y="89" fill="#8fa5b8" font-size="14">${esc(column.sub)}</text>
      <g transform="translate(${COLUMN.padX} 116)">
${column.items
  .map(
    (item, i) =>
      `        <rect${i === 0 ? '' : ` y="${i * 60}"`} width="${COLUMN.itemWidth}" height="48" rx="12" fill="${column.theme.item}"/>` +
      `<text x="${COLUMN.itemPadX}" y="${30 + i * 60}" fill="${column.theme.itemText}" font-size="15">${esc(item)}</text>`
  )
  .join('\n')}
      </g>
      <text x="${COLUMN.padX}" y="305" fill="${column.theme.footer}" font-size="13" font-weight="700">${esc(column.footer)}</text>
    </g>`
  )
  .join('\n\n')}
  </g>

${columns
  .slice(1)
  .map((column) => `  <path d="M${72 + column.x - 25} 325h45" stroke="#6d879d" stroke-width="3" marker-end="url(#arrow)"/>`)
  .join('\n')}

  <g transform="translate(72 545)" font-family="${FONT}">
    <rect width="${VISION.barWidth}" height="106" rx="20" fill="#132234" stroke="#304b64"/>
${placed
  .map((node) =>
    node.arrow
      ? `    <path d="M${node.arrow.x} ${centerY}h${node.arrow.width}" stroke="#6d879d" stroke-width="3" marker-end="url(#arrow)"/>`
      : `    <rect x="${node.box.x}" y="${VISION.boxY}" width="${node.box.width}" height="${VISION.boxHeight}" rx="14" fill="${node.box.theme.fill}"/>` +
        `<text x="${node.box.x + VISION.padX}" y="${centerY + 6}" fill="${node.box.theme.text}" font-size="${VISION.fontSize}"${node.box.theme.weight >= 700 ? ` font-weight="${node.box.theme.weight}"` : ''}>${esc(node.box.label)}</text>`
  )
  .join('\n')}
  </g>
</svg>
`
}
