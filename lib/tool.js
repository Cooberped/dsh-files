// The model-facing read_document tool. Reads through ctx.fs, so workspace
// resolution, sandbox policy and fs-observation policy behave exactly like the
// built-in read tool. Differences from the plain-text read tool: content
// sniffing (never trusts extensions), size pre-check before reading bytes, and
// an LRU parse cache keyed on (targetKey, version, format).
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { sniffFormat, sniffHead, HEAD_SNIFF_BYTES, SUPPORTED_FORMATS, formatFromExtension } from "./detect.js";
import { parseDocument } from "./parse/index.js";
import { splitPdfPages } from "./parse/pdf.js";
import { projectModelPath } from "./model-path.js";
import { windowLines } from "./parse/text.js";
import { parseDocumentLocator, parseWorkbookInventory, renderedSpreadsheetRows, retrievalDocumentVersion, splitPptxSlides } from "./retrieval/blocks.js";
function hashBytes(buf) {
    return createHash('sha256').update(typeof buf === 'string' ? buf : Buffer.from(buf)).digest('hex');
}
/**
 * 单次 read_document 窗口的字符预算。按格式分级：
 * - text：需要逐行精确定位（代码/配置），用满基础预算。
 * - xlsx：按 sheet/row 天然受限，用满基础预算。
 * - pdf/docx/pptx：叙述性流式文本，模型通常只需关键段落，一次塞满会把上下文
 *   稀释并推高 token 成本；给基础预算的一半，配合 windowLines 的截断标记
 *   引导模型用 offset/limit 翻页增量获取。
 */
export function formatOutputBudget(format, base) {
    // pdf/docx/pptx：叙述性流式文本，模型通常只需关键段落，减半防上下文稀释。
    if (format === 'pdf' || format === 'docx' || format === 'pptx')
        return Math.max(2000, Math.floor(base / 2));
    // xlsx：结构化表格信息密度高，但行多列宽也会撑爆上下文；给 3/4，配合
    // windowLines 的截断标记引导模型 offset 翻页增量取。
    if (format === 'xlsx')
        return Math.max(2000, Math.floor(base * 0.75));
    return base;
}
function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`${label} must be a positive integer`);
}
function parseArgs(args, config) {
    if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
        throw new Error('file_path must be a non-empty string');
    }
    const filePath = args.file_path.trim();
    const offsetExplicit = args.offset !== undefined;
    const offset = typeof args.offset === 'number' ? args.offset : 1;
    if (!Number.isInteger(offset) || offset < 1)
        throw new Error('offset must be a positive integer');
    const limit = typeof args.limit === 'number' ? args.limit : config.readLimit;
    if (!Number.isInteger(limit) || limit < 1)
        throw new Error('limit must be a positive integer');
    if (limit > config.readLimit)
        throw new Error(`limit must be less than or equal to ${config.readLimit}`);
    const format = args.format === undefined ? 'auto' : args.format;
    if (typeof format !== 'string' || (format !== 'auto' && !SUPPORTED_FORMATS.has(format))) {
        throw new Error(`unsupported format "${String(format)}" (expected auto, pdf, docx, xlsx, pptx or text)`);
    }
    const sheet = typeof args.sheet === 'number' ? args.sheet : undefined;
    if (sheet !== undefined && (!Number.isInteger(sheet) || sheet < 1)) {
        throw new Error('sheet must be a positive integer');
    }
    const listSheets = args.list_sheets === true;
    if (listSheets && sheet !== undefined) {
        throw new Error('list_sheets and sheet are mutually exclusive: list first, then read a specific sheet');
    }
    const cellRange = typeof args.cell_range === 'string' && args.cell_range.trim() !== ''
        ? args.cell_range.trim()
        : undefined;
    if (cellRange !== undefined && sheet === undefined) {
        throw new Error('cell_range requires sheet: list the workbook, then select a worksheet and range');
    }
    if (listSheets && cellRange !== undefined) {
        throw new Error('list_sheets and cell_range are mutually exclusive');
    }
    const coordinate = typeof args.coordinate === 'string' && args.coordinate.trim() !== ''
        ? args.coordinate.trim().normalize('NFC')
        : undefined;
    if (args.coordinate !== undefined && coordinate === undefined)
        throw new Error('coordinate must be a non-empty string when provided');
    if (coordinate !== undefined && parseDocumentLocator(coordinate) === null) {
        throw new Error(`unsupported coordinate ${JSON.stringify(coordinate)}; pass the value returned by search_documents unchanged`);
    }
    if (coordinate !== undefined && (sheet !== undefined || listSheets || cellRange !== undefined)) {
        throw new Error('coordinate cannot be combined with sheet, list_sheets, or cell_range');
    }
    const version = typeof args.version === 'string' && args.version.trim() !== '' ? args.version.trim() : undefined;
    if (args.version !== undefined && version === undefined)
        throw new Error('version must be a non-empty string when provided');
    if (coordinate !== undefined && version === undefined) {
        throw new Error('version is required when coordinate is provided; pass coordinate and version from the same search_documents result');
    }
    return {
        filePath,
        offset,
        offsetExplicit,
        limit,
        format: format,
        sheet,
        listSheets,
        cellRange,
        coordinate,
        version
    };
}
/** The session workspace cwd for this call, when one applies. */
function sessionCwd(exec) {
    return exec.agent?.session?.header?.cwd;
}
/**
 * Run parseDocument with cooperative cancellation: the underlying parsers
 * (pdfjs/fflate+saxen/read-excel-file) do not take an AbortSignal, so race the
 * parse against the signal and throw the FsError abort code when it fires.
 */
async function parseDocumentWithAbort(bytes, format, options, signal) {
    if (signal.aborted)
        throw new FsError('read_document aborted', 'FS_ABORTED');
    let settle;
    const raced = new Promise((resolve) => {
        settle = resolve;
    });
    const onAbort = () => settle({ ok: false, error: new FsError('read_document aborted', 'FS_ABORTED') });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        void parseDocument(bytes, format, options)
            .then((text) => settle({ ok: true, text }))
            .catch((error) => settle({ ok: false, error }));
        const result = await raced;
        if (result.ok)
            return result.text;
        throw result.error;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function unicodeCharacterSlice(text, startChar, endChar, coordinate) {
    const characters = Array.from(text);
    if (endChar > characters.length) {
        throw new Error(`coordinate ${JSON.stringify(coordinate)} is out of range: source has ${characters.length} Unicode code point(s)`);
    }
    return characters.slice(startChar - 1, endChar).join('');
}
function exactLineCharacterScope(text, locator, input) {
    if (locator.startChar === undefined || locator.endChar === undefined)
        return null;
    if (input.offsetExplicit)
        throw new Error('offset cannot be combined with a character-range coordinate');
    const sourceLine = locator.startLine;
    if (sourceLine === undefined || locator.endLine !== sourceLine) {
        throw new Error(`invalid character-range coordinate ${JSON.stringify(input.coordinate)}`);
    }
    const line = windowLines(text, sourceLine, 1);
    const value = line.lines[0];
    if (value === undefined) {
        throw new Error(`line ${sourceLine} out of range: source has ${line.totalLines} line(s)`);
    }
    return {
        text: unicodeCharacterSlice(value.text, locator.startChar, locator.endChar, input.coordinate ?? ''),
        offset: 1,
        limit: 1,
        lineNumberBase: sourceLine - 1,
        displayOffset: sourceLine,
        totalLines: line.totalLines
    };
}
function coordinateLineWindow(text, locator, input) {
    const characterScope = exactLineCharacterScope(text, locator, input);
    if (characterScope !== null)
        return characterScope;
    const { startLine, endLine } = locator;
    if (startLine !== undefined && endLine !== undefined) {
        if (input.offsetExplicit)
            throw new Error('offset cannot be combined with a coordinate that already contains a line range');
        return { text, offset: startLine, limit: Math.min(input.limit, endLine - startLine + 1) };
    }
    return { text, offset: input.offset, limit: input.limit };
}
export function coordinateScope(text, format, locator, input) {
    if (locator.kind === 'page') {
        if (format !== 'pdf')
            throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires a PDF, detected ${format}`);
        const pages = splitPdfPages(text);
        const page = pages[locator.page - 1];
        if (page === undefined)
            throw new Error(`page ${locator.page} out of range: PDF has ${pages.length} page(s)`);
        return coordinateLineWindow(page, locator, input);
    }
    if (locator.kind === 'slide') {
        if (format !== 'pptx')
            throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires a PPTX, detected ${format}`);
        const slides = splitPptxSlides(text);
        const slide = slides.find((entry) => entry.slide === locator.slide);
        if (slide === undefined)
            throw new Error(`slide ${locator.slide} out of range: PPTX has ${slides.length} slide(s)`);
        return coordinateLineWindow(slide.text, locator, input);
    }
    if (locator.kind === 'line') {
        if (format === 'xlsx')
            throw new Error(`coordinate ${JSON.stringify(input.coordinate)} is not an XLSX cell range`);
        return coordinateLineWindow(text, locator, input);
    }
    if (format !== 'xlsx')
        throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires an XLSX workbook, detected ${format}`);
    if (input.offsetExplicit)
        throw new Error('offset cannot be combined with an XLSX coordinate');
    if (locator.part !== undefined) {
        throw new Error(`legacy XLSX part coordinate ${JSON.stringify(input.coordinate)} is not safely reversible; rerun search_documents and use its new coordinate/version`);
    }
    if (locator.startChar !== undefined && locator.endChar !== undefined) {
        const range = /^[A-Z]{1,3}(\d+):[A-Z]{1,3}(\d+)$/u.exec(locator.cellRange);
        if (range === null || range[1] !== range[2]) {
            throw new Error(`invalid XLSX row character coordinate ${JSON.stringify(input.coordinate)}`);
        }
        const rowNumber = Number(range[1]);
        const row = renderedSpreadsheetRows(text).find((candidate) => candidate.rowNumber === rowNumber);
        if (row === undefined) {
            throw new Error(`row ${rowNumber} from coordinate was not found in worksheet ${JSON.stringify(locator.sheet)}`);
        }
        return {
            text: unicodeCharacterSlice(row.text, locator.startChar, locator.endChar, input.coordinate ?? ''),
            offset: 1,
            limit: input.limit
        };
    }
    return { text, offset: 1, limit: input.limit };
}
function renderContent(path, format, value) {
    const numbered = format === 'text';
    const body = value.lines.map((l) => (numbered ? `${l.number}: ${l.text}` : l.text)).join('\n');
    const scope = value.coordinate === undefined ? '' : ` @ ${value.coordinate}`;
    const header = `### document ${path} (${format})${scope} [version ${value.version}] — offset ${value.offset}, ${value.lines.length}/${value.totalLines} lines`;
    return [header, body].filter((s) => s.length > 0).join('\n');
}
export function defineReadDocumentTool(ctx, config, cache) {
    return defineTool({
        name: 'read_document',
        description: 'Read text/PDF/DOCX/XLSX/PPTX without Python. To expand search evidence, pass the coordinate and version returned by search_documents unchanged; page/slide-local line ranges, Unicode character ranges, and quoted XLSX Sheet!Range values are resolved precisely. Legacy offset/limit and sheet/cell_range calls remain supported. Results report detected value counts and truncation explicitly.',
        parameters: {
            file_path: {
                type: 'string',
                required: true,
                description: 'Path to the document, resolved by the filesystem backend.'
            },
            format: {
                type: 'string',
                enum: ['auto', 'pdf', 'docx', 'xlsx', 'pptx', 'text'],
                description: 'Optional format override; the sniffed content wins over this hint.'
            },
            coordinate: {
                type: 'string',
                description: 'Exact page/slide/line/Sheet!Range coordinate returned by search_documents. Requires the version from the same result. May be combined with offset only for a whole page:N or slide:N coordinate.'
            },
            version: {
                type: 'string',
                description: 'Exact retrieval version returned with the coordinate; required whenever coordinate is provided. If the file or projection schema changed, the call fails and must be re-searched.'
            },
            offset: {
                type: 'integer',
                description: '1-based first line. Defaults to 1.'
            },
            limit: {
                type: 'integer',
                description: `Max lines to return. Defaults to ${config.readLimit}.`
            },
            sheet: {
                type: 'integer',
                description: '1-based worksheet to read in full (XLSX only).'
            },
            list_sheets: {
                type: 'boolean',
                description: 'Inspect worksheet names, used ranges, populated-row counts and non-empty-cell counts (XLSX only).'
            },
            cell_range: {
                type: 'string',
                description: 'Optional A1 range such as A1:F40. Requires sheet and preserves row/column coordinates (XLSX only).'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true },
                    format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'pptx', 'text'] },
                    version: { type: 'string', required: true },
                    coordinate: { type: 'string' },
                    offset: { type: 'integer', required: true },
                    lines: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                number: { type: 'integer', required: true },
                                text: { type: 'string', required: true }
                            }
                        }
                    },
                    totalLines: { type: 'integer', required: true },
                    // execute 在 sheet 读取时返回该字段；schema 必须声明，
                    // 否则 additionalProperties:false 会把合法输出打成 INVALID_TOOL_OUTPUT。
                    sheet: { type: 'integer' }
                }
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: renderContent(value.path, value.format, value)
                }
            ],
            // 结构化行数据投影给 UI：模型侧只看到紧凑行文本，UI 用 card:'read'
            // 渲染行号/高亮/滚动，与官方 read 工具同一惯例。
            presentationMeta: (_args, value) => ({
                path: value.path,
                format: value.format,
                version: value.version,
                ...(value.coordinate === undefined ? {} : { coordinate: value.coordinate }),
                offset: value.offset,
                totalLines: value.totalLines,
                lines: value.lines
            })
        },
        isConcurrencySafe: () => true,
        // PDF 解析可能很慢（大文件 + pdfjs），超时防止模型空等；
        // 具体数值由部署方通过 timeoutMs 配置（policy 层执行）。
        timeoutMs: config.readTimeoutMs ?? 120_000,
        async execute(args, exec) {
            const input = parseArgs(args, config);
            const cwd = sessionCwd(exec);
            const workspaceRoot = cwd === undefined
                ? undefined
                : await ctx.fs.resolve('.', { cwd, signal: exec.signal });
            const target = await ctx.fs.resolve(input.filePath, {
                ...(cwd !== undefined ? { cwd } : {}),
                signal: exec.signal
            });
            if (workspaceRoot !== undefined && !ctx.fs.contains(workspaceRoot, target)) {
                throw new Error('document target is outside the active session workspace');
            }
            const modelPath = projectModelPath(input.filePath, target.displayPath, cwd);
            const info = await ctx.fs.stat(target, exec.signal);
            if (info === undefined) {
                ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
                throw new FsError(`cannot read "${modelPath}": not found`, 'FS_NOT_FOUND');
            }
            if (info.type !== 'file') {
                throw new FsError(`cannot read "${modelPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
            }
            if (info.size !== undefined && info.size > config.maxFileBytes) {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${modelPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`, 'FS_TOO_LARGE');
            }
            // readBytes 的 maxBytes 是整个文件上限：底层 stat 后若 size > maxBytes
            // 直接抛 FS_TOO_LARGE，不做截断。因此不能先按 64 KiB 嗅探头部——那会把
            // 任何更大的文件挡在门外。一次读满 maxFileBytes，格式判定从缓冲头部截取。
            const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes);
            const head = bytes.subarray(0, Math.min(HEAD_SNIFF_BYTES, bytes.length));
            const headFormat = sniffHead(head);
            if (headFormat === null && input.format === 'auto') {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${modelPath}": unrecognized file content (expected text, PDF, DOCX, XLSX or PPTX)`, 'FS_NOT_TEXT');
            }
            // zip 需要中央目录（在文件尾部）才能区分 docx/xlsx；
            // headFormat 为 null 只发生在显式 format 场景，走完整嗅探兜底。
            // auto 模式下的 hint 取扩展名：字节完全未知时（且非已知二进制）
            // 允许按扩展名兜底解析，解析器仍会校验结构并 loud fail。
            const hint = input.format === 'auto' ? (formatFromExtension(input.filePath) ?? undefined) : input.format;
            const format = headFormat === 'zip' || headFormat === null
                ? sniffFormat(bytes, hint)
                : headFormat;
            if (format === null) {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${modelPath}": unrecognized file content (expected text, PDF, DOCX, XLSX or PPTX)`, 'FS_NOT_TEXT');
            }
            const contentHash = hashBytes(bytes);
            const version = retrievalDocumentVersion(bytes);
            if (input.version !== undefined && input.version !== version) {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new Error(`cannot expand coordinate for "${modelPath}": requested version ${input.version}, current version ${version}; rerun search_documents and use its new coordinate/version`);
            }
            const locator = input.coordinate === undefined ? undefined : parseDocumentLocator(input.coordinate);
            if (locator === null) {
                throw new Error(`unsupported coordinate ${JSON.stringify(input.coordinate)}; rerun search_documents`);
            }
            // sheet/list_sheets 只对 xlsx 有意义：对 PDF/DOCX/text 显式报错，
            // 防止模型以为 sheet 参数生效而拿到完整（未按 sheet 过滤）内容。
            if ((input.sheet !== undefined || input.listSheets || input.cellRange !== undefined) && format !== 'xlsx') {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${modelPath}": sheet/list_sheets/cell_range parameters are only supported for XLSX files (detected format: ${format})`, 'FS_NOT_TEXT');
            }
            let selectedSheet = input.sheet;
            let selectedCellRange = input.cellRange;
            let listSheets = input.listSheets;
            let coordinateFullSheetProjection = false;
            if (locator?.kind === 'sheet') {
                if (format !== 'xlsx') {
                    throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires an XLSX workbook, detected ${format}`);
                }
                const inventory = await cache.getOrCompute({
                    targetKey: target.targetKey,
                    version: contentHash,
                    format,
                    listSheets: true
                }, () => parseDocumentWithAbort(bytes, format, {
                    sheetRowLimit: config.sheetRowLimit,
                    maxSheets: config.maxSheets,
                    listOnly: true
                }, exec.signal));
                const sheets = parseWorkbookInventory(inventory);
                const selected = sheets.find((sheet) => sheet.name === locator.sheet);
                if (selected === undefined) {
                    throw new Error(`worksheet ${JSON.stringify(locator.sheet)} from coordinate was not found; available sheets: ${sheets.map((sheet) => JSON.stringify(sheet.name)).join(', ')}`);
                }
                selectedSheet = selected.index;
                if (locator.part !== undefined) {
                    throw new Error(`legacy XLSX part coordinate ${JSON.stringify(input.coordinate)} is not safely reversible; rerun search_documents and use its new coordinate/version`);
                }
                coordinateFullSheetProjection = locator.startChar !== undefined;
                selectedCellRange = coordinateFullSheetProjection ? undefined : locator.cellRange;
                listSheets = false;
            }
            else if (locator?.kind === 'page' && format !== 'pdf') {
                throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires a PDF, detected ${format}`);
            }
            else if (locator?.kind === 'slide' && format !== 'pptx') {
                throw new Error(`coordinate ${JSON.stringify(input.coordinate)} requires a PPTX, detected ${format}`);
            }
            else if (locator?.kind === 'line' && format === 'xlsx') {
                throw new Error(`coordinate ${JSON.stringify(input.coordinate)} is not an XLSX cell range`);
            }
            const cacheKey = {
                targetKey: target.targetKey,
                version: contentHash,
                format,
                sheet: selectedSheet,
                listSheets,
                // A full-sheet coordinate projection must not alias a normal limited
                // sheet read in the parse cache: their sheetRowLimit contracts differ.
                cellRange: coordinateFullSheetProjection ? '__dsh_coordinate_full_sheet__' : selectedCellRange
            };
            // getOrCompute 自带 in-flight 去重：并发分页同一文件只解析一次。
            const text = await cache.getOrCompute(cacheKey, () => 
            // 解析器不接受 AbortSignal；这里包装一层协作取消：
            // 信号触发时立即中止等待，符合 dsh 工具的取消契约。
            parseDocumentWithAbort(bytes, format, {
                sheetRowLimit: coordinateFullSheetProjection ? Number.MAX_SAFE_INTEGER : config.sheetRowLimit,
                maxSheets: config.maxSheets,
                sheet: selectedSheet,
                listOnly: listSheets,
                cellRange: selectedCellRange
            }, exec.signal));
            const scope = locator === undefined
                ? { text, offset: input.offset, limit: input.limit }
                : coordinateScope(text, format, locator, input);
            const window = windowLines(scope.text, scope.offset, scope.limit, formatOutputBudget(format, config.maxOutputChars));
            const lines = scope.lineNumberBase === undefined
                ? window.lines
                : window.lines.map((line) => ({ ...line, number: line.number + scope.lineNumberBase }));
            ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
            return {
                path: modelPath,
                format,
                version,
                ...(input.coordinate === undefined ? {} : { coordinate: input.coordinate }),
                offset: scope.displayOffset ?? scope.offset,
                lines,
                totalLines: scope.totalLines ?? window.totalLines,
                ...(selectedSheet !== undefined ? { sheet: selectedSheet } : {})
            };
        },
        presentCall(args) {
            return {
                card: 'generic',
                title: typeof args.coordinate === 'string'
                    ? `Read document ${args.file_path} @ ${args.coordinate}`
                    : `Read document ${args.file_path}`,
                kind: 'read',
                locations: [{ path: args.file_path }]
            };
        },
        presentResult(_args, result) {
            if (result.isError)
                return undefined;
            // meta 就是 presentationMeta 的投影产物（ToolResult.meta 原样透传）。
            const meta = result.meta;
            if (meta === undefined)
                return undefined;
            if (meta.format === 'text') {
                return {
                    card: 'read',
                    path: meta.path,
                    offset: meta.offset,
                    lines: meta.lines,
                    totalLines: meta.totalLines
                };
            }
            return {
                card: 'generic',
                title: `Document ${meta.path} (${meta.format})`,
                content: [
                    {
                        type: 'text',
                        text: meta.lines.map((l) => l.text).join('\n')
                    }
                ]
            };
        }
    });
}
