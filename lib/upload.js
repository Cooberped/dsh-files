// Upload HTTP surface. Security model:
//   - loopback-only host, same-origin and same-site checks (mirrors the
//     official dsh-files-button contract)
//   - files land in a path-contained per-session directory under the session's
//     own cwd (`.dsh-filess/<storageKey>`), so the agent's fs backend can
//     resolve them. Request authorization remains the Harness/deployment layer's
//     responsibility; a storage key is not an authentication credential.
//   - sanitized file names, size cap, optional extension allowlist, sha256
//     content dedup, bounded concurrency, TTL sweep
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sniffFormat } from "./detect.js";
import { jsonError, networkGuard } from "./guard.js";
/** Safe-by-default session storage budget. Callers may explicitly pass 0 to disable it. */
export const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;
/** Folder uploads may preserve at most this many directory components. */
export const MAX_UPLOAD_RELATIVE_DEPTH = 16;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_SESSION_ID_BYTES = 1024;
const CONTENT_DIGEST_HEX_LENGTH = 16;
class UnsafeUploadPathError extends Error {
    constructor() {
        super('unsafe upload path');
        this.name = 'UnsafeUploadPathError';
    }
}
function isErrno(err, code) {
    return err?.code === code;
}
function pathIsWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/**
 * Control chars, path separators, dot segments and leading dots stripped;
 * then truncated by UTF-8 BYTES, not characters, with the extension
 * preserved: 120 CJK characters are 360 bytes and exceed the common 255-byte
 * filename limit, so writeFile would fail with ENAMETOOLONG on long Chinese
 * names — but cutting the stem must not also cut ".pdf"/".xlsx", or the
 * extension allowlist and client badge would see a nameless file.
 */
export function sanitizeFileName(raw) {
    // Double quotes cannot be represented by Harness' stable @"path" grammar;
    // strip them at the storage boundary together with control characters.
    // macOS Finder frequently supplies decomposed NFD names. Persist NFC so the
    // upload card, @ reference and later coordinate lookup use one stable form.
    const cleaned = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f"]/g, '');
    const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    const joined = segments.join('_').replace(/^\.+/, '').trim();
    // 分离扩展名：最后一个点之后的 1-8 个字符（无空格、无点）。该形状约束是
    // 必需的而不是描述性的——扩展名整体从字节预算中扣除，一个不受限的尾段
    // （`a.` + 300 字符）会把 stem 预算压成负数，切出空 stem 并原样保留超长
    // 尾段，最终 open() 抛 ENAMETOOLONG 变成 500。尾段不像扩展名时，整串按
    // stem 处理，照常受 MAX_BYTES 截断。
    // 注意 joined 已剥掉前导点，但 ".foo" 会变成 "foo"（无点），
    // 而 "..." 会被剥成空串，走 upload.bin 兜底。
    const dot = joined.lastIndexOf('.');
    const candidateExt = dot > 0 && dot < joined.length - 1 ? joined.slice(dot) : '';
    const ext = /^\.[^\s.]{1,8}$/u.test(candidateExt) ? candidateExt : '';
    const stem = ext === '' ? joined : joined.slice(0, dot);
    // 纯点串（"." / ".."）不是合法文件名。
    if (/^\.+$/.test(stem))
        return 'upload.bin';
    const MAX_BYTES = 120;
    const extBytes = Buffer.byteLength(ext);
    let bytes = 0;
    let cut = stem.length;
    // 按字符（code point）迭代而不是按 code unit 遍历：codePointAt + i++ 会
    // 在 astral 字符（emoji，4 字节）中途把切点停在代理对中间，切出孤立代理
    // （\ud83d.pdf 这类损坏文件名）。for...of 每次给一个完整字符，ch.length
    // 是该字符在 UTF-16 里的 code unit 数（astral=2, BMP=1），切点永远落在
    // 完整字符边界。
    let codeUnit = 0;
    for (const ch of stem) {
        const code = ch.codePointAt(0) ?? 0;
        const width = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
        const next = codeUnit + ch.length;
        if (bytes + width > MAX_BYTES - extBytes) {
            cut = codeUnit;
            break;
        }
        bytes += width;
        codeUnit = next;
    }
    const name = stem.slice(0, cut) + ext;
    return name === '' ? 'upload.bin' : name;
}
/**
 * Map an opaque session id to a filesystem-safe, collision-resistant key.
 *
 * Safe Harness ids remain byte-for-byte stable. Unsafe ids keep a readable
 * prefix plus a hash of the ORIGINAL id, so `a/b` and `a:b` cannot collapse
 * into the same upload directory. A leading `~` keeps hashed keys outside the
 * safe raw-id alphabet, preventing a chosen safe id from colliding with the
 * rendered hash key. The raw id is still passed unchanged to the Harness
 * session resolver; this function is only for storage paths, not authorization.
 */
export function sanitizeSessionId(id) {
    if (id === '')
        return 'anonymous';
    if (SAFE_SESSION_ID.test(id))
        return id;
    const digest = createHash('sha256').update(id).digest('hex').slice(0, 32);
    const stem = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 47);
    return `~${stem === '' ? 'session' : stem}-${digest}`;
}
/** Raw session ids are resolver credentials; reject controls/oversize, never lossy-normalize them. */
export function isValidSessionId(id) {
    return id !== '' && Buffer.byteLength(id, 'utf8') <= MAX_SESSION_ID_BYTES && !/[\u0000-\u001f\u007f]/.test(id);
}
/**
 * 上传文件的读取体量提示：给前端/后续读取一个「读起来贵不贵」的档位。
 * 模型侧体量感知由 read_document 的 totalLines 承担，这里主要帮前端预览/预判成本。
 */
export function readHintFor(sniffedFormat, bytes) {
    const cost = bytes > 8 * 1024 * 1024 ? 'expensive' : bytes > 1024 * 1024 ? 'moderate' : 'cheap';
    // 仅文本可粗略估算可读字符（UTF-8 中文 <1 字/字节、ASCII 1:1），其它
    // 格式文本量无法从字节直推，给一个保守默认。
    const estimatedChars = sniffedFormat === 'text' ? Math.min(24000, Math.max(2000, Math.round(bytes * 0.6))) : 12000;
    return { cost, estimatedChars };
}
/**
 * Create/check every directory below a trusted workspace anchor one component
 * at a time. The workspace itself may intentionally be a symlink supplied by
 * Harness; `.dsh-filess`, the session storage root and every upload subfolder
 * may not be symlinks and must resolve under that anchor.
 */
async function ensureSafeDirectoryChain(workspaceRoot, target, create) {
    const anchor = resolve(workspaceRoot);
    const candidate = resolve(target);
    if (!pathIsWithin(anchor, candidate))
        throw new UnsafeUploadPathError();
    if (create)
        await mkdir(anchor, { recursive: true });
    const canonicalAnchor = await realpath(anchor);
    const anchorInfo = await lstat(canonicalAnchor);
    if (!anchorInfo.isDirectory())
        throw new UnsafeUploadPathError();
    const rel = relative(anchor, candidate);
    let current = anchor;
    for (const segment of rel === '' ? [] : rel.split(sep)) {
        current = join(current, segment);
        let info;
        try {
            info = await lstat(current);
        }
        catch (err) {
            if (!create || !isErrno(err, 'ENOENT'))
                throw err;
            try {
                await mkdir(current, { mode: 0o700 });
            }
            catch (mkdirErr) {
                // Another actor may have created the component after lstat. Re-check
                // it below and accept only a real directory, never a symlink.
                if (!isErrno(mkdirErr, 'EEXIST'))
                    throw mkdirErr;
            }
            info = await lstat(current);
        }
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new UnsafeUploadPathError();
        const canonicalCurrent = await realpath(current);
        if (!pathIsWithin(canonicalAnchor, canonicalCurrent))
            throw new UnsafeUploadPathError();
    }
}
async function assertSafeRegularFile(storageRoot, path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
        throw new UnsafeUploadPathError();
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(storageRoot), realpath(path)]);
    if (!pathIsWithin(canonicalRoot, canonicalPath))
        throw new UnsafeUploadPathError();
}
/** Return an existing, real digest file; matching symlinks fail closed. */
async function findExistingDigestFile(dir, storageRoot, prefix) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch (err) {
        if (isErrno(err, 'ENOENT'))
            return undefined;
        throw err;
    }
    let existing;
    for (const entry of entries) {
        if (!entry.startsWith(`${prefix}-`))
            continue;
        const path = join(dir, entry);
        await assertSafeRegularFile(storageRoot, path);
        existing ??= path;
    }
    return existing;
}
/** Count regular-file payload bytes; any symlink/special file fails closed. */
async function storedFileBytes(dir) {
    const rootInfo = await lstat(dir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
        throw new UnsafeUploadPathError();
    const canonicalRoot = await realpath(dir);
    let total = 0;
    const pending = [dir];
    while (pending.length > 0) {
        const current = pending.pop();
        const currentInfo = await lstat(current);
        if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory())
            throw new UnsafeUploadPathError();
        const canonicalCurrent = await realpath(current);
        if (!pathIsWithin(canonicalRoot, canonicalCurrent))
            throw new UnsafeUploadPathError();
        const entries = await readdir(current);
        for (const entry of entries) {
            const path = join(current, entry);
            const info = await lstat(path);
            if (info.isSymbolicLink())
                throw new UnsafeUploadPathError();
            if (info.isDirectory())
                pending.push(path);
            else if (info.isFile())
                total += info.size;
            else
                throw new UnsafeUploadPathError();
        }
    }
    return total;
}
/** Final-component no-follow write. Ancestor checks are repeated immediately before this call. */
async function writeNewUploadFile(path, data) {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags, 0o600);
    try {
        const info = await handle.stat();
        if (!info.isFile())
            throw new UnsafeUploadPathError();
        await handle.writeFile(data);
    }
    finally {
        await handle.close();
    }
}
export function createUploadHandler(options) {
    const { maxBytes, allowedExtensions, ttlMs, maxConcurrent, maxSessionBytes = DEFAULT_MAX_SESSION_BYTES, sessionCwd, defaultDir, onStorageRoot, trustedHosts = [], now = () => Date.now() } = options;
    let inflight = 0;
    const storageTails = new Map();
    /** Serialize quota-check + persist inside one session so concurrent uploads cannot overshoot its budget. */
    async function withStorageLock(key, action) {
        const previous = storageTails.get(key) ?? Promise.resolve();
        let release = () => { };
        const gate = new Promise((resolveGate) => {
            release = resolveGate;
        });
        const tail = previous.then(() => gate);
        storageTails.set(key, tail);
        await previous;
        try {
            return await action();
        }
        finally {
            release();
            if (storageTails.get(key) === tail)
                storageTails.delete(key);
        }
    }
    async function storageDirFor(req) {
        const raw = req.headers['x-session-id'];
        if (raw !== undefined && typeof raw !== 'string') {
            return { ok: false, status: 400, error: 'invalid session id' };
        }
        // Preserve the direct-handler compatibility fallback. The real Harness
        // client always supplies its current session id.
        const sessionId = raw ?? 'anonymous';
        if (!isValidSessionId(sessionId))
            return { ok: false, status: 400, error: 'invalid session id' };
        if (sessionCwd !== undefined) {
            const cwd = await sessionCwd(sessionId);
            if (cwd === undefined)
                return { ok: false, status: 403, error: 'unknown session' };
            const workspaceRoot = resolve(cwd);
            onStorageRoot?.(workspaceRoot);
            return { ok: true, dir: join(workspaceRoot, '.dsh-filess', sanitizeSessionId(sessionId)), sessionId, workspaceRoot };
        }
        const workspaceRoot = resolve(defaultDir);
        onStorageRoot?.(workspaceRoot);
        return { ok: true, dir: join(workspaceRoot, '.dsh-filess', sanitizeSessionId(sessionId)), sessionId, workspaceRoot };
    }
    function uploadMetadata(req) {
        let rawName = 'upload.bin';
        try {
            const header = req.headers['x-file-name'];
            if (typeof header === 'string' && header !== '')
                rawName = decodeURIComponent(header);
            else if (header !== undefined && typeof header !== 'string')
                return { ok: false, error: 'invalid file name' };
        }
        catch {
            return { ok: false, error: 'invalid file name' };
        }
        const name = sanitizeFileName(rawName);
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'bin';
        let subDir = '';
        const relativeHeader = req.headers['x-file-relative-path'];
        if (relativeHeader !== undefined) {
            if (typeof relativeHeader !== 'string')
                return { ok: false, error: 'invalid relative path' };
            try {
                const decoded = decodeURIComponent(relativeHeader);
                const normalized = decoded.replace(/\\/g, '/').split('/').filter((s) => s !== '');
                // webkitRelativePath includes the file name; the preceding segments
                // are directories. Count raw segments (including dot segments) so a
                // malicious header cannot hide arbitrary depth behind sanitization.
                const directories = normalized.slice(0, -1);
                if (directories.length > MAX_UPLOAD_RELATIVE_DEPTH) {
                    return { ok: false, error: `relative path exceeds ${MAX_UPLOAD_RELATIVE_DEPTH} directories` };
                }
                const safe = directories
                    .filter((s) => s !== '.' && s !== '..')
                    .map((s) => sanitizeFileName(s))
                    .filter((s) => s !== 'upload.bin' && s !== '');
                subDir = safe.join('/');
            }
            catch {
                return { ok: false, error: 'invalid relative path' };
            }
        }
        return { ok: true, name, ext, subDir };
    }
    async function handlePost(req, res) {
        // 限流检查必须与 inflight += 1 之间无 await（Node 单线程下原子），
        // 且要在 storageDirFor 之后——否则两个请求可同时通过检查。
        const storage = await storageDirFor(req);
        if (!storage.ok) {
            req.resume();
            jsonError(res, storage.status, storage.error);
            return;
        }
        if (inflight >= maxConcurrent) {
            req.resume();
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'too many concurrent uploads' }));
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            req.resume();
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload too large' }));
            return;
        }
        // Extension/depth validation is metadata-only and must happen before the
        // request body is buffered. This keeps rejected binaries out of memory.
        const metadata = uploadMetadata(req);
        if (!metadata.ok) {
            req.resume();
            jsonError(res, 400, metadata.error);
            return;
        }
        if (allowedExtensions.length > 0 && !allowedExtensions.includes(metadata.ext)) {
            req.resume();
            jsonError(res, 415, `extension ".${metadata.ext}" not allowed`);
            return;
        }
        inflight += 1;
        try {
            const chunks = [];
            let total = 0;
            for await (const chunk of req) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > maxBytes) {
                    // 提前阻止继续缓冲，但要排空剩余请求体，否则 keep-alive 连接
                    // 会被未消费的 body 挂起，导致后续上传卡住。
                    req.resume();
                    res.writeHead(413, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'payload too large' }));
                    return;
                }
                chunks.push(buf);
            }
            if (total === 0) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'empty upload' }));
                return;
            }
            const { name, subDir } = metadata;
            const data = Buffer.concat(chunks);
            const digest = createHash('sha256').update(data).digest('hex').slice(0, CONTENT_DIGEST_HEX_LENGTH);
            // 文件夹上传保留子目录层级：x-file-relative-path 里的目录前缀重建在
            // 会话上传目录内（如 sub/dir/file.pdf → <session>/.dsh-filess/<sid>/sub/dir/<digest>-file.pdf）。
            // 相对路径已按 POSIX 解析、限深并去除 dot 段，始终限制在会话目录内。
            const dirWithSub = subDir === '' ? storage.dir : join(storage.dir, subDir);
            const dest = join(dirWithSub, `${digest}-${name}`);
            const persisted = await withStorageLock(storage.dir, async () => {
                // Create and verify `.dsh-filess` and the session root one component at
                // a time. `mkdir(..., recursive)` would follow a pre-existing
                // intermediate symlink before we could inspect it.
                await ensureSafeDirectoryChain(storage.workspaceRoot, storage.dir, true);
                // 会话配额递归统计文件夹上传内容；目录 inode 的 stat.size 不是
                // payload。遇到任意 symlink/special file 都 fail closed，且同一会话
                // 检查与写入串行，避免并发超额。
                if (maxSessionBytes > 0) {
                    const used = await storedFileBytes(storage.dir);
                    if (used + data.length > maxSessionBytes)
                        return null;
                }
                // Create requested subfolders only after the quota admits the payload;
                // otherwise rejected bodies could consume uncounted directory inodes.
                await ensureSafeDirectoryChain(storage.workspaceRoot, dirWithSub, dirWithSub !== storage.dir);
                const existing = await findExistingDigestFile(dirWithSub, storage.dir, digest);
                if (existing !== undefined)
                    return { path: existing, deduplicated: true };
                // Node exposes O_NOFOLLOW for the final file but no portable openat()
                // that pins every ancestor directory. Re-checking lstat+realpath here,
                // opening the final component with O_NOFOLLOW, then checking again
                // blocks pre-existing/observable symlinks. It cannot make path lookup
                // race-free against a same-uid process that swaps an ancestor during
                // the final syscall; that local concurrent-mutation boundary requires
                // OS sandboxing or a native dirfd/openat implementation.
                await ensureSafeDirectoryChain(storage.workspaceRoot, dirWithSub, false);
                try {
                    await writeNewUploadFile(dest, data);
                }
                catch (err) {
                    if (isErrno(err, 'ELOOP'))
                        throw new UnsafeUploadPathError();
                    if (!isErrno(err, 'EEXIST'))
                        throw err;
                    // A concurrent creator won the final-component race. Accept only a
                    // real, contained digest file; symlinks and special files reject.
                    await ensureSafeDirectoryChain(storage.workspaceRoot, dirWithSub, false);
                    const raced = await findExistingDigestFile(dirWithSub, storage.dir, digest);
                    if (raced === undefined)
                        throw err;
                    return { path: raced, deduplicated: true };
                }
                await ensureSafeDirectoryChain(storage.workspaceRoot, dirWithSub, false);
                await assertSafeRegularFile(storage.dir, dest);
                return { path: dest, deduplicated: false };
            });
            if (persisted === null) {
                res.writeHead(507, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `session upload quota exceeded (${maxSessionBytes} bytes)` }));
                return;
            }
            const { path, deduplicated } = persisted;
            // 嗅探前移：上传时字节已在内存，顺手判定真实格式（不信任扩展名），
            // 客户端据此显示真实格式徽章，伪装文件一上传就暴露。
            const sniffedFormat = sniffFormat(data);
            res.writeHead(200, { 'content-type': 'application/json' });
            // Keep the model/user projection workspace-relative. The absolute path
            // remains server-internal, avoiding disclosure of `/Users/...` while the
            // fs backend can still resolve the reference against the session cwd.
            const projectedPath = relative(storage.workspaceRoot, path).split(sep).join('/');
            res.end(JSON.stringify({
                path: projectedPath,
                name,
                bytes: data.length,
                sessionId: storage.sessionId,
                sniffedFormat,
                readHint: readHintFor(sniffedFormat, data.length),
                ...(deduplicated ? { deduplicated: true } : {})
            }));
        }
        catch (err) {
            if (err instanceof UnsafeUploadPathError) {
                jsonError(res, 403, err.message);
                return;
            }
            console.error('[dsh-files] upload persist failed:', err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'write failed' }));
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleDelete(req, res) {
        const storage = await storageDirFor(req);
        if (!storage.ok) {
            jsonError(res, storage.status, storage.error);
            return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        // URLSearchParams already percent-decodes once. A second decode would
        // corrupt legitimate names such as `100%20 plan.xlsx`.
        const target = url.searchParams.get('path') ?? '';
        if (target === '') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing path' }));
            return;
        }
        const root = resolve(storage.dir);
        // New clients send workspace-relative paths; resolve them from that
        // workspace. Absolute paths from older clients remain supported, then go
        // through the same containment check below.
        const resolved = resolve(storage.workspaceRoot, target);
        if (resolved !== root && !resolved.startsWith(root + sep)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'path outside session upload dir' }));
            return;
        }
        try {
            await withStorageLock(storage.dir, async () => {
                // Check every parent from the workspace anchor, including
                // `.dsh-filess` and the session root, then reject a final symlink too.
                // As with POST, portable Node path APIs cannot eliminate a malicious
                // same-uid ancestor swap in the final lstat→unlink syscall window.
                await ensureSafeDirectoryChain(storage.workspaceRoot, dirname(resolved), false);
                await assertSafeRegularFile(storage.dir, resolved);
                await unlink(resolved);
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ removed: true }));
        }
        catch (err) {
            if (err instanceof UnsafeUploadPathError) {
                jsonError(res, 403, err.message);
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        }
    }
    return async (req, res) => {
        if (req.method !== 'POST' && req.method !== 'DELETE') {
            res.writeHead(405, { allow: 'POST, DELETE' });
            res.end('method not allowed');
            return;
        }
        const denied = networkGuard(req, trustedHosts);
        if (denied !== null) {
            res.writeHead(403);
            res.end(denied);
            return;
        }
        if (req.method === 'DELETE') {
            await handleDelete(req, res);
            return;
        }
        await handlePost(req, res);
    };
}
/**
 * Remove uploaded files older than `ttlMs` and the emptied session
 * directories. Returns a dispose function; safe to call concurrently with
 * uploads (a file written after the sweep's readdir is newer than the sweep
 * window, and unlink failures are ignored).
 */
export function createSweeper(roots, ttlMs, intervalMs, now = () => Date.now()) {
    if (intervalMs <= 0)
        return () => undefined;
    const timer = setInterval(() => {
        const current = typeof roots === 'function' ? roots() : [roots];
        for (const root of new Set(current)) {
            void sweep(root, ttlMs, now).catch((err) => {
                console.error('[dsh-files] upload sweep failed:', err);
            });
        }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
export async function sweep(root, ttlMs, now = () => Date.now()) {
    const cutoff = now() - ttlMs;
    let removedFiles = 0;
    let removedDirs = 0;
    // Uploaded files live at <root>/.dsh-filess/<sessionId>/; session dirs are
    // the only entries directly under the uploads base.
    const base = join(root, '.dsh-filess');
    let baseInfo;
    try {
        baseInfo = await lstat(base);
    }
    catch (err) {
        if (isErrno(err, 'ENOENT'))
            return { removedFiles: 0, removedDirs: 0 };
        throw err;
    }
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory())
        throw new UnsafeUploadPathError();
    const sessions = await readdir(base);
    const sweepDirectory = async (dir) => {
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry);
            try {
                // lstat avoids following a user-created symlink out of the upload
                // tree. A stale symlink is treated as a file and only the link itself
                // is removed.
                const info = await lstat(path);
                if (info.isDirectory()) {
                    await sweepDirectory(path);
                }
                else if (info.mtimeMs < cutoff) {
                    await unlink(path);
                    removedFiles += 1;
                }
            }
            catch {
                // raced with a DELETE or another sweep
            }
        }
        try {
            const remaining = await readdir(dir);
            if (remaining.length === 0) {
                await rmdir(dir);
                removedDirs += 1;
            }
        }
        catch {
            // directory is non-empty or raced with another operation
        }
    };
    for (const session of sessions) {
        const dir = join(base, session);
        try {
            const info = await lstat(dir);
            if (info.isDirectory())
                await sweepDirectory(dir);
        }
        catch {
            // raced with a DELETE or another sweep
        }
    }
    return { removedFiles, removedDirs };
}
