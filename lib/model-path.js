import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
function posixPath(value) {
    return value.split(sep).join('/').normalize('NFC');
}
function containedRelative(base, candidate) {
    const projected = relative(resolve(base), resolve(candidate));
    if (projected === '..' || projected.startsWith(`..${sep}`) || isAbsolute(projected)) {
        throw new Error('resolved document path is outside the active session workspace');
    }
    if (projected === '')
        throw new Error('resolved document path is the workspace root, not a document');
    return posixPath(projected);
}
/**
 * Return a model-facing path without exposing an absolute host path. When a
 * session cwd is available, the resolved target must be contained by it and
 * the projection is derived from the resolved target rather than trusting the
 * caller spelling. Without a cwd, a relative caller path is preserved; an
 * absolute path is reduced to its basename as a privacy-safe fallback.
 */
export function projectModelPath(requestedPath, resolvedDisplayPath, cwd) {
    const requested = requestedPath.trim().normalize('NFC');
    const resolvedPath = resolvedDisplayPath.normalize('NFC');
    if (cwd !== undefined) {
        const resolvedCandidate = resolvedPath === '' ? requested : resolvedPath;
        const candidate = isAbsolute(resolvedCandidate)
            ? resolvedCandidate
            : resolve(cwd, normalize(resolvedCandidate));
        return containedRelative(cwd, candidate);
    }
    if (!isAbsolute(requested))
        return posixPath(normalize(requested));
    return basename(requested).normalize('NFC');
}
