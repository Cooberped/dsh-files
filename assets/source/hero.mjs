// Hero banner. Geometry is written once; the badge, the four capability pills
// and the SEARCH chip are sized from their own text, which is the part that
// used to be recomputed by hand for every locale.

import { advance, assertFits, boxWidth, esc, pillWidth, slotWidth } from './metrics.mjs'

export const size = { width: 1440, height: 620 }

const FONT =
  'Inter, &quot;PingFang SC&quot;, &quot;Hiragino Sans GB&quot;, &quot;Microsoft YaHei&quot;, ' +
  '&quot;Noto Sans CJK SC&quot;, &quot;Source Han Sans SC&quot;, ui-sans-serif, system-ui, sans-serif'

const PILL_ACCENTS = ['#f3c66b', '#5bd6c3', '#8aa3ff', '#ff8f75']
const PILL = { fontSize: 15, weight: 650, textX: 40, padRight: 20, gap: 14, height: 45 }

const FILE_CARD = { width: 106, gap: 12, padX: 18 }
const FILE_THEME = [
  { fill: '#351d21', stroke: '#8e4b45', kind: '#ff9b89', name: '#f5e8e5' },
  { fill: '#172a46', stroke: '#3d6295', kind: '#8ab7ff', name: '#e2edfb' },
  { fill: '#173529', stroke: '#39775d', kind: '#75d5a8', name: '#e2f4eb' }
]

export function render(t) {
  // The badge hugs its own text; letter-spacing counts, so measure with it.
  const badgeWidth = Math.round(20 + advance(t.badge, { fontSize: 15, weight: 700, letterSpacing: 2 }) + 20)

  let cursor = 0
  const pills = t.pills.map((label, index) => {
    const width = pillWidth(label, PILL)
    const node = { label, width, x: cursor, accent: PILL_ACCENTS[index] }
    cursor += width + PILL.gap
    return node
  })
  if (cursor - PILL.gap > 780) {
    throw new Error(`hero: capability pills need ${Math.ceil(cursor - PILL.gap)}px but only 780px is clear of the pipeline card`)
  }

  const searchBadgeWidth = boxWidth(t.searchBadge, { fontSize: 12, weight: 700, padX: 12 })

  const files = t.files.map((file, index) => {
    const x = index * (FILE_CARD.width + FILE_CARD.gap)
    const available = slotWidth(FILE_CARD.width, FILE_CARD.padX)
    assertFits(file.name, { fontSize: 14, available, where: `hero:files[${index}].name` })
    assertFits(file.kind, { fontSize: 12, weight: 700, available, where: `hero:files[${index}].kind` })
    return { ...file, x, theme: FILE_THEME[index] }
  })

  assertFits(t.query, { fontSize: 15, available: slotWidth(342, 18), where: 'hero:query' })
  assertFits(t.evidence, { fontSize: 14, available: slotWidth(342, 18), where: 'hero:evidence' })
  assertFits(t.headline, { fontSize: 28, weight: 520, available: 780, where: 'hero:headline' })
  assertFits(t.tagline, { fontSize: 18, available: 780, where: 'hero:tagline' })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(t.title)}</title>
  <desc id="desc">${esc(t.desc)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#08111f"/>
      <stop offset="0.58" stop-color="#0d1a2d"/>
      <stop offset="1" stop-color="#10283a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f3c66b"/>
      <stop offset="1" stop-color="#5bd6c3"/>
    </linearGradient>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.4" fill="#ffffff" opacity=".055"/>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity=".28"/>
    </filter>
  </defs>
  <rect width="${size.width}" height="${size.height}" rx="36" fill="url(#bg)"/>
  <rect width="${size.width}" height="${size.height}" rx="36" fill="url(#dots)"/>
  <path d="M0 498C268 425 444 524 700 478c291-52 459-188 740-110v252H0Z" fill="#163348" opacity=".42"/>

  <g transform="translate(92 82)" font-family="${FONT}">
    <rect width="${badgeWidth}" height="38" rx="19" fill="#f3c66b" opacity=".12" stroke="#f3c66b" stroke-opacity=".42"/>
    <text x="20" y="25" fill="#f6d594" font-size="15" font-weight="700" letter-spacing="2">${esc(t.badge)}</text>
    <text x="0" y="150" fill="#f8fbff" font-size="78" font-weight="760" letter-spacing="-3">${esc(t.wordmark)}</text>
    <rect x="2" y="176" width="104" height="7" rx="3.5" fill="url(#accent)"/>
    <text x="0" y="242" fill="#d8e4ef" font-size="28" font-weight="520">${esc(t.headline)}</text>
    <text x="0" y="288" fill="#8fa5b8" font-size="18">${esc(t.tagline)}</text>

    <g transform="translate(0 350)" font-size="${PILL.fontSize}" font-weight="${PILL.weight}">
${pills
  .map(
    (pill) =>
      `      <rect x="${pill.x}" width="${pill.width}" height="${PILL.height}" rx="${PILL.height / 2}" fill="#172a40" stroke="#31465c"/>\n` +
      `      <circle cx="${pill.x + 23}" cy="${PILL.height / 2}" r="6" fill="${pill.accent}"/><text x="${pill.x + PILL.textX}" y="28" fill="#dce8f2">${esc(pill.label)}</text>`
  )
  .join('\n')}
    </g>
  </g>

  <g transform="translate(886 72)" filter="url(#shadow)">
    <rect width="446" height="474" rx="30" fill="#0b1626" stroke="#30465d"/>
    <g transform="translate(34 34)" font-family="${FONT}">
      <text x="0" y="22" fill="#6f879b" font-size="14" font-weight="700" letter-spacing="1.4">${esc(t.pipeline)}</text>
      <g transform="translate(0 54)">
${files
  .map(
    (file) =>
      `        <rect x="${file.x}" width="${FILE_CARD.width}" height="78" rx="14" fill="${file.theme.fill}" stroke="${file.theme.stroke}"/>\n` +
      `        <text x="${file.x + FILE_CARD.padX}" y="31" fill="${file.theme.kind}" font-size="12" font-weight="700">${esc(file.kind)}</text>\n` +
      `        <text x="${file.x + FILE_CARD.padX}" y="54" fill="${file.theme.name}" font-size="14">${esc(file.name)}</text>`
  )
  .join('\n')}
      </g>
      <path d="M171 151v39" stroke="#5bd6c3" stroke-width="2.5" stroke-linecap="round"/>
      <path d="m162 181 9 10 9-10" fill="none" stroke="#5bd6c3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <g transform="translate(0 202)">
        <rect width="342" height="82" rx="16" fill="#132638" stroke="#325068"/>
        <rect x="18" y="17" width="${searchBadgeWidth}" height="24" rx="12" fill="#23445b"/>
        <text x="30" y="34" fill="#9cc4da" font-size="12" font-weight="700">${esc(t.searchBadge)}</text>
        <text x="18" y="62" fill="#e4eef6" font-size="15">${esc(t.query)}</text>
        <text x="257" y="34" fill="#6f879b" font-size="12">${esc(t.backend)}</text>
      </g>
      <path d="M171 296v39" stroke="#f3c66b" stroke-width="2.5" stroke-linecap="round"/>
      <path d="m162 326 9 10 9-10" fill="none" stroke="#f3c66b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <g transform="translate(0 347)">
        <rect width="342" height="72" rx="16" fill="#251f18" stroke="#6c5732"/>
        <text x="18" y="29" fill="#f4d897" font-size="12" font-weight="700">${esc(t.evidenceBadge)}</text>
        <text x="18" y="52" fill="#f7efe0" font-size="14">${esc(t.evidence)}</text>
      </g>
    </g>
  </g>
</svg>
`
}
