import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.name !== '@cooberped/dsh-files') throw new Error(`unexpected package name: ${pkg.name}`)
if (!/^0\.6\.0-beta\.\d+$/.test(pkg.version)) throw new Error(`unexpected beta version: ${pkg.version}`)
if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error('official npm registry is not pinned')
if (pkg.publishConfig?.access !== 'public') throw new Error('scoped package must publish with public access')
if (pkg.publishConfig?.tag !== 'beta') throw new Error('prerelease must publish under the beta dist-tag')

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(command, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
})

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status || 1)
}

const [artifact] = JSON.parse(result.stdout)
const paths = new Set(artifact.files.map((file) => file.path))
for (const required of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'README.zh.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js'
]) {
  if (!paths.has(required)) throw new Error(`npm tarball is missing ${required}`)
}

const forbiddenPrefixes = ['assets/', 'benchmark/', 'node_modules/', 'scripts/', 'src/', 'test/', '.dsh-files', '.dsh-filess']
for (const path of paths) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`npm tarball unexpectedly contains ${path}`)
  }
}

if (artifact.unpackedSize > 1024 * 1024) {
  throw new Error(`npm tarball unpacked size ${artifact.unpackedSize} exceeds 1 MiB`)
}
if (artifact.bundled?.length) throw new Error(`bundled dependencies are not allowed: ${artifact.bundled.join(', ')}`)

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('id: "@cooberped/dsh-files"')) {
  throw new Error('client bundle was not rebuilt with the scoped ModuleLoader id')
}

const sourceMap = JSON.parse(readFileSync(new URL('../lib/client.js.map', import.meta.url), 'utf8'))
const thirdPartySources = sourceMap.sources.filter((source) => source.includes('node_modules'))
if (thirdPartySources.length) {
  throw new Error(`client sourcemap embeds third-party sources: ${thirdPartySources.join(', ')}`)
}

console.log(`${artifact.id}: ${artifact.entryCount} files, ${artifact.size} byte tarball, ${artifact.unpackedSize} bytes unpacked`)
