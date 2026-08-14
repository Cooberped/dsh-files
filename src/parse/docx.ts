// DOCX text extraction via mammoth (maintained, pure JS, no known advisories).

import mammoth from 'mammoth'

export async function parseDocx(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return result.value
}
