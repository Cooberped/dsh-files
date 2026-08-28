// PDF text extraction via pdfjs-dist (Mozilla's maintained renderer).
// Replaces pdf-parse@1.1.1 (unmaintained since 2020, crash-prone debug path).
// Text layer only — no rendering, no font downloads (useSystemFonts for any
// embedded font fallback stays local).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
/**
 * Stable page boundary for the string projection consumed by read_document and
 * the retrieval projector. A form-feed sentinel cannot be confused with the
 * ordinary blank lines that may legitimately occur inside a PDF page.
 */
export const PDF_PAGE_SEPARATOR = '\n\f\n';
export function splitPdfPages(text) {
    return text.split(PDF_PAGE_SEPARATOR);
}
/**
 * Extract the text layer of a PDF as line-oriented text (one entry per
 * original line where the content stream marks EOLs), pages separated by a
 * blank line.
 */
export async function parsePdf(bytes) {
    // pdfjs 会把传入的 data.buffer 作为 transferable 转移（Node 26 的 LoopbackPort
    // 对 detached buffer 的二次 transfer 抛 DataCloneError），因此解析前必须复制
    // 一份工作副本，保住调用方的 bytes 不被 detach。
    const doc = await getDocument({
        data: new Uint8Array(bytes),
        // Node has no web worker; these options keep the legacy build self-contained.
        disableWorker: true,
        isEvalSupported: false,
        useSystemFonts: true
    }).promise;
    try {
        const pages = [];
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
            const page = await doc.getPage(pageNo);
            try {
                const content = await page.getTextContent();
                const lines = [];
                let line = '';
                let prevX;
                let prevWidth;
                for (const item of content.items) {
                    if ('str' in item) {
                        // 相邻 text run 之间若存在水平间隙则补空格：PDF 常把一个
                        // 单词/句子拆成多个 run，直接拼接会得到 "Helloworld"。
                        const x = item.transform?.[4];
                        const width = 'width' in item ? item.width : undefined;
                        if (prevX !== undefined && prevWidth !== undefined && x !== undefined && x > prevX + prevWidth + 1) {
                            line += ' ';
                        }
                        line += item.str;
                        prevX = x;
                        prevWidth = width;
                        if (item.hasEOL) {
                            lines.push(line);
                            line = '';
                            prevX = undefined;
                            prevWidth = undefined;
                        }
                    }
                }
                if (line !== '')
                    lines.push(line);
                pages.push(lines.join('\n'));
            }
            finally {
                page.cleanup();
            }
        }
        const text = pages.join(PDF_PAGE_SEPARATOR);
        // 扫描件/纯图片 PDF 没有文本层：返回显式提示而非空串，
        // 防止模型把「无文本」误读成「空文件」。
        if (text.trim() === '' && doc.numPages > 0) {
            // Keep the original page cardinality even for an all-image document so
            // page:N remains machine-addressable. The diagnostic lives on page 1;
            // later empty pages stay empty rather than silently shifting coordinates.
            pages[0] = '[此 PDF 没有文本层（可能是扫描件或纯图片文档），read_document 无法提取文字内容]';
            return pages.join(PDF_PAGE_SEPARATOR);
        }
        return text;
    }
    finally {
        await doc.destroy();
    }
}
