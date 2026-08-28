#!/usr/bin/env node
// Generate assets/readme/*.svg from assets/source/.
//
//   node scripts/build-assets.mjs           write the files
//   node scripts/build-assets.mjs --check   fail if anything on disk is stale
//
// The generated SVGs stay tracked, exactly like lib/: a reader of the repository
// or the rendered README never needs a build step, while --check in the release
// gate proves the committed files still match their source. Nothing here is
// published to npm — package.json "files" excludes assets/ and scripts/.

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'assets', 'source')
const outDir = join(root, 'assets', 'readme')

const { LOCALES, content, fileName } = await import(join(sourceDir, 'content.mjs'))

const DIAGRAMS = ['hero', 'architecture', 'evidence-loop']

async function build() {
  const outputs = []
  for (const diagram of DIAGRAMS) {
    const { render } = await import(join(sourceDir, `${diagram}.mjs`))
    for (const locale of LOCALES) {
      const strings = content[diagram]?.[locale]
      if (strings === undefined) throw new Error(`missing content for ${diagram}/${locale}`)
      outputs.push({ name: fileName(diagram, locale), svg: render(strings) })
    }
  }
  return outputs
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const check = process.argv.includes('--check')
const outputs = await build()

// A generated tree that silently keeps an orphan is not reproducible either.
const known = new Set(outputs.map((output) => output.name))
const stray = (await readdir(outDir)).filter((entry) => entry.endsWith('.svg') && !known.has(entry))
if (stray.length > 0) {
  console.error(`assets: ${stray.join(', ')} is in assets/readme/ but nothing in assets/source/ generates it`)
  process.exit(1)
}

const stale = []
for (const { name, svg } of outputs) {
  const path = join(outDir, name)
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === svg) continue
  if (check) {
    stale.push(name)
    continue
  }
  await writeFile(path, svg)
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `assets out of date: ${stale.join(', ')}\n` +
        'Run `pnpm assets:build` and commit the result. Do not hand-edit assets/readme/*.svg.'
    )
    process.exit(1)
  }
  console.log(`assets up to date (${outputs.length} files)`)
} else {
  for (const { name, svg } of outputs) {
    console.log(`${name.padEnd(24)} ${String(Buffer.byteLength(svg)).padStart(6)}B  sha256:${sha256(svg).slice(0, 16)}`)
  }
  console.log('\nRecord any new file in assets/README.md with its full SHA-256.')
}
