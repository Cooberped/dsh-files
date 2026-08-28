// Text advance estimation for the README diagrams.
//
// The diagrams are static SVG served through <img>, so nothing measures text at
// render time: every pill width and x offset has to be decided when the file is
// written. Hand-computing that per language is what this module exists to stop.
//
// The model is deliberately coarse. A Han glyph is one em; Latin advances come
// from a small class table for Inter-ish proportions. It is accurate to a few
// percent, which is why every consumer adds real padding on top rather than
// trusting the number to the pixel.

/** Full-width scripts and punctuation: one em per glyph. */
const FULL_WIDTH =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}＀-￯　-〿]/u

// Measured advances, as a fraction of the em, for the font stack these diagrams
// declare. Produced by rendering each character at 100px through canvas
// measureText() in Chrome and dividing by the size; regenerate the same way if
// the stack changes. Guessed class averages were wrong by up to 10% on all-caps
// strings — exactly where a label runs into its border.
const LATIN = {
  "0": 0.6, "1": 0.401, "2": 0.6, "3": 0.6, "4": 0.6, "5": 0.6, "6": 0.6,
  "7": 0.547, "8": 0.6, "9": 0.6, " ": 0.333, "!": 0.333, "\"": 0.427, "#": 0.6,
  "$": 0.6, "%": 0.97, "&": 0.726, "'": 0.244, "(": 0.333, ")": 0.333, "*": 0.506,
  "+": 0.605, ",": 0.264, "-": 0.605, ".": 0.264, "/": 0.5, ":": 0.264, ";": 0.264,
  "<": 0.605, "=": 0.605, ">": 0.605, "?": 0.537, "@": 0.858, "A": 0.657, "B": 0.677,
  "C": 0.728, "D": 0.706, "E": 0.637, "F": 0.577, "G": 0.748, "H": 0.72, "I": 0.237,
  "J": 0.517, "K": 0.69, "L": 0.588, "M": 0.882, "N": 0.719, "O": 0.767, "P": 0.642,
  "Q": 0.767, "R": 0.676, "S": 0.632, "T": 0.619, "U": 0.714, "V": 0.639, "W": 0.93,
  "X": 0.637, "Y": 0.662, "Z": 0.624, "[": 0.333, "\\": 0.5, "]": 0.333, "^": 0.518,
  "_": 0.5, "`": 0.333, "a": 0.559, "b": 0.586, "c": 0.547, "d": 0.586, "e": 0.555,
  "f": 0.343, "g": 0.591, "h": 0.556, "i": 0.256, "j": 0.267, "k": 0.529, "l": 0.235,
  "m": 0.855, "n": 0.559, "o": 0.586, "p": 0.586, "q": 0.586, "r": 0.365, "s": 0.505,
  "t": 0.355, "u": 0.56, "v": 0.482, "w": 0.755, "x": 0.509, "y": 0.496, "z": 0.487,
  "{": 0.333, "|": 0.195, "}": 0.333, "~": 0.5, "·": 0.5, "“": 0.537, "”": 0.537,
  "…": 1, "—": 1, "–": 0.824, "、": 0.525, "，": 0.525, "。": 0.525, "；": 0.525,
  "：": 0.525, "？": 1, "！": 1
}

/** Anything unmeasured: roughly the median lowercase advance. */
const LATIN_FALLBACK = 0.55

/** Bold is a hair wider at the same size; the measured median ratio is 1.02. */
const BOLD_RATIO = 1.02

// The viewer's machine picks the font, so no table can be exact. A small margin
// keeps assertFits() erring toward "too tight" rather than shipping a clipped label.
const SAFETY = 1.03

function latinAdvance(ch) {
  const measured = LATIN[ch]
  return measured === undefined ? LATIN_FALLBACK : measured
}

/**
 * Estimated rendered width of `text` in user units.
 *
 * `letterSpacing` mirrors the SVG attribute: it is added after every glyph,
 * including the last one, which is what the renderer does.
 */
export function advance(text, { fontSize, weight = 400, letterSpacing = 0 } = {}) {
  if (typeof fontSize !== 'number') throw new TypeError('advance() requires a numeric fontSize')
  let em = 0
  let glyphs = 0
  for (const ch of text) {
    glyphs += 1
    em += FULL_WIDTH.test(ch) ? 1 : latinAdvance(ch)
  }
  // Heavier weights are marginally wider at the same size.
  const weighted = em * (weight >= 600 ? BOLD_RATIO : 1) * SAFETY
  return weighted * fontSize + glyphs * letterSpacing
}

/**
 * Width of a pill whose content is a leading dot plus a label.
 * `textX` is where the label starts; `padRight` is the gap after it.
 */
export function pillWidth(label, { fontSize, weight, textX, padRight }) {
  return Math.round(textX + advance(label, { fontSize, weight }) + padRight)
}

/**
 * Width of a box that hugs a centred label.
 */
export function boxWidth(label, { fontSize, weight, padX }) {
  return Math.round(advance(label, { fontSize, weight }) + padX * 2)
}

/**
 * Right-edge clearance every left-aligned label keeps inside its container.
 * The constraint is "do not run into the border", not "pad symmetrically".
 */
export const CLEARANCE = 8

/** Space a left-aligned label may occupy inside a box of `width` starting at `textX`. */
export function slotWidth(width, textX) {
  return width - textX - CLEARANCE
}

/**
 * Assert that `text` fits inside a fixed-width container.
 *
 * The grid diagrams cannot auto-size — widening one card would break the
 * columns — so the build fails loudly instead of emitting a clipped label. This
 * is the check that replaces "I measured it by hand and it looked fine".
 */
export function assertFits(text, { fontSize, weight = 400, available, where }) {
  const needed = advance(text, { fontSize, weight })
  if (needed > available) {
    throw new Error(
      `asset text overflows its container at ${where}: ` +
        `"${text}" needs ~${Math.ceil(needed)}px at ${fontSize}px, but only ${available}px is available. ` +
        'Shorten the string in assets/source/content.mjs, or change the layout deliberately.'
    )
  }
  return text
}

/** XML text escaping for content that lands between tags or inside an attribute. */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
