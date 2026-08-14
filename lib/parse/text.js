// Plain-text decoding with BOM-aware UTF-16 support; UTF-8 otherwise.
export function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8').decode(bytes);
}
/** Split decoded text into 1-based line windows without a trailing phantom line. */
export function windowLines(text, offset, limit) {
    const endsWithNewline = text.endsWith('\n');
    const all = text.split('\n');
    if (endsWithNewline && all.length > 0)
        all.pop();
    const totalLines = all.length;
    const start = Math.max(0, offset - 1);
    const end = Math.min(totalLines, start + limit);
    return {
        totalLines,
        lines: all.slice(start, end).map((text, i) => ({ number: start + i + 1, text }))
    };
}
