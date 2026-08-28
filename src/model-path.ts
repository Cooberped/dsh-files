import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

function posixPath(value: string): string {
  return value.split(sep).join('/').normalize('NFC')
}

function containedRelative(base: string, candidate: string): string | undefined {
  const projected = relative(resolve(base), resolve(candidate))
  if (projected === '..' || projected.startsWith(`..${sep}`) || isAbsolute(projected)) {
    return undefined
  }
  if (projected === '') return undefined
  return posixPath(projected)
}

function isUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
}

function reusableRelative(value: string): string | undefined {
  if (value === '' || /[\0\r\n]/u.test(value) || isUri(value) || isAbsolute(value)) return undefined
  const projected = normalize(value)
  if (
    projected === '.' ||
    projected === '..' ||
    projected.startsWith(`..${sep}`) ||
    isAbsolute(projected)
  ) return undefined
  return posixPath(projected)
}

/**
 * Return a reusable model-facing path after the caller has authorized target
 * containment with FileSystem.contains(). displayPath is deliberately ignored:
 * it is neither containment evidence nor guaranteed to be accepted by a later
 * resolve(). Remote URIs or targets with no safe workspace-relative spelling
 * fail closed instead of exposing host identity.
 */
export function projectModelPath(requestedPath: string, _resolvedDisplayPath: string, cwd?: string): string {
  const requested = requestedPath.trim().normalize('NFC')
  const requestedRelative = reusableRelative(requested)
  if (requestedRelative !== undefined) return requestedRelative
  if (cwd !== undefined && isAbsolute(requested) && isAbsolute(cwd)) {
    const projected = containedRelative(cwd, requested)
    if (projected !== undefined) return projected
  }
  throw new Error('document target cannot be represented as a reusable workspace-relative path')
}
