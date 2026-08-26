// Shared query/index tokenizer. The text stored in FTS is already tokenized so
// SQLite's unicode61 tokenizer only has to preserve whitespace-delimited terms.
// Chinese runs use overlapping bigrams; non-CJK letters/numbers stay whole.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD = /[\p{L}\p{N}]/u

export interface QueryPlan {
  /** FTS5 MATCH expression. Empty when the query only contains single CJK chars. */
  ftsQuery: string
  /** Same exact phrases joined with OR; used only when strict multi-term search is empty. */
  relaxedFtsQuery: string
  /** Ordered token groups; each inner array is one exact phrase. */
  phrases: string[][]
  /** Single CJK characters use a bounded substring fallback. */
  singleCharacters: string[]
  /** NFKC-normalized source query retained for the private query log. */
  normalizedQuery: string
}

interface Segment {
  kind: 'cjk' | 'word'
  value: string
}

function segments(value: string): Segment[] {
  const output: Segment[] = []
  let kind: Segment['kind'] | undefined
  let buffer = ''
  const flush = () => {
    if (kind !== undefined && buffer !== '') output.push({ kind, value: buffer })
    kind = undefined
    buffer = ''
  }
  // Search content uses NFKC (filenames still use NFC elsewhere). This folds
  // PDF compatibility glyphs such as `⼼` back to `心`, and full-width ASCII
  // back to ordinary tokens without changing phrase order.
  for (const char of value.normalize('NFKC')) {
    const next = CJK.test(char) ? 'cjk' : WORD.test(char) ? 'word' : undefined
    if (next === undefined) {
      flush()
      continue
    }
    if (kind !== undefined && kind !== next) flush()
    kind = next
    buffer += char
  }
  flush()
  return output
}

function bigrams(value: string): string[] {
  const chars = Array.from(value)
  const output: string[] = []
  for (let index = 0; index + 1 < chars.length; index += 1) {
    output.push(chars[index] + chars[index + 1])
  }
  return output
}

/** Tokenize document text for both SQLite FTS5 and the JS fallback backend. */
export function tokenizeForIndex(value: string): string[] {
  const output: string[] = []
  for (const segment of segments(value)) {
    if (segment.kind === 'cjk') {
      // A one-character CJK run is deliberately absent from the FTS stream;
      // those queries use the scoped substring path instead of polluting BM25.
      output.push(...bigrams(segment.value))
    } else {
      output.push(segment.value.toLocaleLowerCase('en-US'))
    }
  }
  return output
}

function quoteFtsPhrase(tokens: string[]): string {
  // Tokens originate from Unicode letters/numbers only, but escaping here
  // keeps this helper safe if the tokenizer is widened later.
  return `"${tokens.join(' ').replace(/"/g, '""')}"`
}

/**
 * Build an order-preserving FTS5 plan. `流程绩效` becomes the exact phrase
 * `"流程 程绩 绩效"`, so the reversed `绩效流程` cannot satisfy it.
 */
export function buildQueryPlan(value: string): QueryPlan {
  const normalizedQuery = value.normalize('NFKC').trim()
  const phrases: string[][] = []
  const singleCharacters: string[] = []
  for (const segment of segments(normalizedQuery)) {
    if (segment.kind === 'cjk') {
      const tokens = bigrams(segment.value)
      if (tokens.length === 0) singleCharacters.push(segment.value)
      else phrases.push(tokens)
    } else {
      phrases.push([segment.value.toLocaleLowerCase('en-US')])
    }
  }
  return {
    normalizedQuery,
    phrases,
    singleCharacters: [...new Set(singleCharacters)],
    ftsQuery: phrases.map(quoteFtsPhrase).join(' AND '),
    relaxedFtsQuery: phrases.map(quoteFtsPhrase).join(' OR ')
  }
}

/** Exact contiguous phrase matching used by the in-memory fallback backend. */
export function containsTokenPhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0) return true
  outer: for (let start = 0; start + phrase.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (haystack[start + offset] !== phrase[offset]) continue outer
    }
    return true
  }
  return false
}
