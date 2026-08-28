// Browser-safe prompt projection for Harness' stable @file grammar.
/** The official grammar cannot represent control characters or embedded quotes. */
export function isRepresentableFileRef(ref) {
    return ref !== '' && !/[\u0000-\u001f\u007f-\u009f"]/u.test(ref);
}
/** Serialize one workspace-relative path exactly as Harness expects. */
export function modelFileMention(ref) {
    if (!isRepresentableFileRef(ref)) {
        throw new Error('file path contains characters unsupported by the Harness @file grammar');
    }
    return /\s/u.test(ref) ? `@"${ref}"` : `@${ref}`;
}
