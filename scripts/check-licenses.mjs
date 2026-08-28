import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(command, ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
})

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status || 1)
}

const report = JSON.parse(result.stdout)
const allowed = new Set(['MIT', 'ISC', 'Apache-2.0'])
const unexpected = Object.keys(report).filter((license) => !allowed.has(license))
if (unexpected.length) {
  throw new Error(`production dependency licenses require review: ${unexpected.join(', ')}`)
}

const observed = new Map()
for (const [license, packages] of Object.entries(report)) {
  for (const pkg of packages) observed.set(pkg.name, license)
}

const expectedDirect = new Map([
  ['fflate', 'MIT'],
  ['pdfjs-dist', 'Apache-2.0'],
  ['read-excel-file', 'MIT'],
  ['saxen', 'MIT']
])

for (const [name, license] of expectedDirect) {
  if (observed.get(name) !== license) {
    throw new Error(`${name} expected ${license}, observed ${observed.get(name) || 'missing'}`)
  }
}

const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
for (const marker of [
  'GPL-2.0-only WITH Liberation font exception',
  'https://github.com/mozilla/pdf.js/pull/21750'
]) {
  if (!notices.includes(marker)) throw new Error(`THIRD_PARTY_NOTICES.md is missing: ${marker}`)
}

console.log(`production license policy passed (${observed.size} packages; ${Object.keys(report).join(', ')})`)
