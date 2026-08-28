// Recommended model evidence loop: inventory, retrieve, expand, answer.
//
// Four equal cards on a fixed pitch, so nothing here auto-sizes; every string is
// checked against its card instead, and the build fails on an over-long label
// rather than emitting one that runs past the card edge.

import { assertFits, esc, slotWidth } from './metrics.mjs'

export const size = { width: 1440, height: 560 }

const FONT =
  'Inter, &quot;PingFang SC&quot;, &quot;Hiragino Sans GB&quot;, &quot;Microsoft YaHei&quot;, ' +
  '&quot;Noto Sans CJK SC&quot;, &quot;Source Han Sans SC&quot;, ui-sans-serif, system-ui, sans-serif'

const CARD = { width: 250, height: 235, pitch: 330, padX: 24, chipWidth: 202, chipPadX: 15 }
const CARD_THEME = [
  { accent: '#f3c66b', badgeText: '#182331', chip: '#f3f6f9', chipText: '#21384b', chipSub: '#6d8091' },
  { accent: '#5bd6c3', badgeText: '#17302c', chip: '#edf8f6', chipText: '#20463f', chipSub: '#5f7b75' },
  { accent: '#8aa3ff', badgeText: '#1d2851', chip: '#f0f2ff', chipText: '#2b3d79', chipSub: '#6978a0' },
  { accent: '#ff8f75', badgeText: '#4d201a', chip: '#fff2ef', chipText: '#673129', chipSub: '#90655e' }
]

export function render(t) {
  const slot = slotWidth(CARD.width, CARD.padX)
  const chipSlot = slotWidth(CARD.chipWidth, CARD.chipPadX)

  const cards = t.cards.map((card, index) => {
    assertFits(card.name, { fontSize: 19, weight: 700, available: slotWidth(CARD.width, 60), where: `evidence-loop:cards[${index}].name` })
    assertFits(card.prompt, { fontSize: 14, available: slot, where: `evidence-loop:cards[${index}].prompt` })
    assertFits(card.chip, { fontSize: 13, weight: 700, available: chipSlot, where: `evidence-loop:cards[${index}].chip` })
    assertFits(card.chipSub, { fontSize: 12, available: chipSlot, where: `evidence-loop:cards[${index}].chipSub` })
    for (const [i, note] of card.notes.entries()) {
      assertFits(note, { fontSize: 13, available: slot, where: `evidence-loop:cards[${index}].notes[${i}]` })
    }
    return { ...card, x: index * CARD.pitch, theme: CARD_THEME[index] }
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(t.title)}</title>
  <desc id="desc">${esc(t.desc)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f7f9fc"/><stop offset="1" stop-color="#edf3f7"/></linearGradient>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0l10 5-10 5z" fill="#8094a8"/></marker>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="11" flood-color="#16324a" flood-opacity=".12"/></filter>
  </defs>
  <rect width="${size.width}" height="${size.height}" rx="32" fill="url(#bg)"/>
  <text x="72" y="72" fill="#102235" font-family="${FONT}" font-size="34" font-weight="760">${esc(t.headline)}</text>
  <text x="72" y="108" fill="#61768a" font-family="${FONT}" font-size="17">${esc(t.subhead)}</text>
  <g transform="translate(70 175)" font-family="${FONT}" filter="url(#shadow)">
${cards
  .map(
    (card, index) => `    <g${card.x === 0 ? '' : ` transform="translate(${card.x})"`}>
      <rect width="${CARD.width}" height="${CARD.height}" rx="22" fill="#ffffff" stroke="#d6e0e8"/>
      <circle cx="32" cy="32" r="17" fill="${card.theme.accent}"/><text x="27" y="38" fill="${card.theme.badgeText}" font-size="16" font-weight="800">${index + 1}</text>
      <text x="60" y="39" fill="#14283a" font-size="19" font-weight="700">${esc(card.name)}</text>
      <text x="${CARD.padX}" y="84" fill="#53697c" font-size="14">${esc(card.prompt)}</text>
      <rect x="${CARD.padX}" y="105" width="${CARD.chipWidth}" height="52" rx="12" fill="${card.theme.chip}"/>
      <text x="${CARD.padX + CARD.chipPadX}" y="127" fill="${card.theme.chipText}" font-size="13" font-weight="700">${esc(card.chip)}</text>
      <text x="${CARD.padX + CARD.chipPadX}" y="146" fill="${card.theme.chipSub}" font-size="12">${esc(card.chipSub)}</text>
      <text x="${CARD.padX}" y="193" fill="#697d8e" font-size="13">${esc(card.notes[0])}</text>
      <text x="${CARD.padX}" y="213" fill="#697d8e" font-size="13">${esc(card.notes[1])}</text>
    </g>`
  )
  .join('\n')}
  </g>
${cards
  .slice(1)
  .map((card) => `  <path d="M${70 + card.x - 10} 293h78" stroke="#8094a8" stroke-width="3" marker-end="url(#arrow)"/>`)
  .join('\n')}
</svg>
`
}
