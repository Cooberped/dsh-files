<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="dsh-files: one package. A composer paperclip for uploads, a document-reading tool for the model, and native image support for vision models.">
</p>

# dsh-files

One package, one line of cordis config. A composer paperclip for uploads, a document-reading tool for the model, and native image support that hands JPEG/PNG/WebP/GIF to any vision-capable model.

> **Part of the taxueseek DeepSeek Harness plugin lineup** — flagship: [argo](https://github.com/taxueseek/argo) (search infrastructure for agents) · siblings: [dsh-snippets](https://github.com/taxueseek/dsh-snippets) (snippet favorites) · [dsh-healthcheck](https://github.com/taxueseek/dsh-healthcheck) (read-only checkup) · [dsh-plugin-guard](https://github.com/taxueseek/dsh-plugin-guard) (plugin security audit) · [taxue-dsh-artisan](https://github.com/taxueseek/taxue-dsh-artisan) (prompt reverse-engineering & multi-provider image generation) — see all plugins on the [profile](https://github.com/taxueseek#deepseek-harness-plugins)

<p align="center">
  <img src="assets/composer.png" alt="DeepSeek Harness composer: paperclip upload button and colored file cards" width="900">
</p>

DeepSeek Harness dual-face plugin. Four capabilities:

- **Upload** — paperclip button, folder button, and drag-and-drop anywhere; `@` file candidates; local session-isolated storage with TTL sweep and sha256 dedup. Files are written under `<session-workdir>/.dsh-filess/<storageKey>/` so the agent's fs backend can always resolve them.
- **Native images** — JPEG/PNG/WebP/GIF uploads are handed to the harness core attachment pipeline (`ctx.attachments` → base64 `image_url`), so any model that declares an `image` input modality actually sees the picture, rendered through the stock native image rail.
- **On-demand document retrieval** — `search_documents` indexes a content version once, then returns compact evidence with a page, line range or `Sheet!Range`. It prefers FTS5 from Harness' actual Node runtime and automatically falls back to a dependency-free JS memory index.
- **Document reading** — `read_document` directly reads text / PDF / DOCX / XLSX / PPTX with content sniffing, paged reads, workbook inventory, coordinate-aware A1 ranges, slide-order/speaker-note extraction, an LRU parse cache and cooperative cancellation.

## Features

### Upload

- **Three entry points**: a paperclip button in the composer toolbar for multi-select files, a folder button for an entire directory (the browser flattens the tree and preserves relative paths per sub-directory), and drag-and-drop anywhere on the page. Document/directory drops are captured before Harness' image-only handler while pure raster drops remain native. Batch uploads are bounded to 4 concurrent requests, and a per-file failure never blocks the rest.

<p align="center">
  <img src="assets/upload-folder-images.png" alt="Batch folder upload: multiple images uploaded at once and shown as a grid" width="900">
</p>

- **Folder batch upload**: selecting or dropping a folder recursively flattens its files, keeps the sub-directory layout under the session dir, and uploads with bounded concurrency — so a whole folder's content lands in one go.
- **`@` dual-source candidates**: typing `@` lists both uploaded files and workspace files. Both are projected as workspace-relative paths, resolved against the session cwd, so `/Users/...` is no longer disclosed in the conversation.
- **Native document rail**: compact horizontal cards are colored by the *byte-sniffed* format and show name, size, and `uploading / AI-readable / failed` state. References use Harness' stable `@file` grammar and quote paths containing spaces.
- **Security rail**: loopback host + same-origin authority + `sec-fetch-site` checks, plus the actual socket peer when implicit loopback trust is used; `trustedHosts` for a deployment-controlled reverse proxy (bare host matches any port, `host:port` matches exactly); file-name sanitization; unknown session 403; concurrency limit (default 4) → 429; oversized and disallowed-extension requests are rejected before buffering the body.
- **Read hint**: the upload response carries a `readHint` (`cost` / `estimatedChars`) so the client can pre-judge how expensive a file is to read.
- **Lifecycle**: TTL sweep (default 7 days) covers every observed session workspace and recursively removes folder uploads, with empty dirs reaped, a default 512 MiB per-session quota (serialized meter + write), and sha256 content dedup.

### Native images

- Uploaded raster images (JPEG / PNG / WebP / GIF) no longer land as a local path that `read_document` cannot read — they go through the harness core attachment pipeline: `createDraftImages` → `addImages` to the composer draft, then `serializeDraftImages` → base64 `image_url` at request time via the provider adapter.
- **Any image-capable model works**: because the wire form is the supplier-neutral base64 `image_url`, every model that declares `inputModalities: [text, image]` (DeepSeek vision, Dots3, LongCat, OpenRouter vision models, …) actually sees the picture — not just DeepSeek.
- **Native UI**: the attachment is rendered by the harness's stock `conversation.input.attachments` rail — thumbnail, click-to-zoom lightbox, native remove — so images look native instead of a grey badge card. dsh-files does not inject that slot; it hands the image to the core and lets the official components render it.

<p align="center">
  <img src="assets/native-image-dialog.png" alt="Vision model reading an uploaded image through the native pipeline" width="900">
</p>

### Document reading

- **Index/search, then expand**: for “understand these files first” tasks, call `search_documents(file_paths)` without a query to build the private index and return only a compact inventory. For a concrete question, call `search_documents(file_paths, query)`; it parses only a new content-sha256 version and returns relevant evidence blocks. `read_document` remains the coordinate expander when more context is needed.
- **Order-correct Chinese retrieval**: contiguous CJK runs become overlapping bigrams queried as an FTS phrase, so `流程绩效` does not match a block containing only `绩效流程`. Single CJK characters use a selected-document substring fallback; ASCII-number tokens such as `Q3` and `IPD` stay whole.
- **Runtime fallback**: startup probes the actual Harness Node, SQLite version, FTS5 compile option and an ordered-phrase query. Any failure selects the in-process JS backend and returns an explicit non-persistent-backend notice with a path-free error category; raw diagnostics stay in the local internal logger.
- **Versioned coordinates**: evidence carries a parser/block-schema-bound content version. PDF pages, PPTX slides, quoted XLSX `Sheet!Range` and text/DOCX line ranges can be passed with that version directly to `read_document`; oversized source lines add a reversible 1-based Unicode code-point `chars:S-E` range. Coordinate expansion requires a non-empty matching version before file I/O. Stale versions fail closed, and legacy XLSX `part:N` coordinates explicitly require a new search.
- **Private lifecycle**: the default persistent index is `$DSH_HOME/dsh-files/index` (directory `0700`, database and WAL/SHM files `0600`). A configured pre-existing directory with group/other access is rejected to the memory fallback rather than chmodded. Query persistence is off by default and becomes subject to its TTL only when `retrievalQueryLogEnabled` is explicitly enabled.

- **Content sniffing**: PDF header, ZIP central-directory members (docx/xlsx/pptx), UTF-8 (fatal), UTF-16 BOM, UTF-16 without BOM, and GB18030 — all decided from bytes, never the extension. A spoofed extension (an executable or an image renamed to `.pdf`) is rejected.
- **Encoding chain**: UTF-16 BOM → UTF-8 (fatal, rejects NUL) → GB18030 (fatal) → UTF-16 without BOM (high-confidence guard), so Chinese GBK and BOM-less UTF-16 files both read.
- **Paged reads**: line numbers + `offset`/`limit` pagination for long documents; the window character budget is tiered by format (text full, xlsx 3/4, pdf/docx/pptx 1/2, see `maxOutputChars`) and truncates with an explicit marker that counts surviving lines, steering the model to page incrementally.
- **Line-number policy by format**: text (code/config) carries line numbers for precise location; PDF/DOCX/XLSX/PPTX paragraph streams drop them to save tokens.
- **XLSX structure-first reads**: `list_sheets` returns every sheet name, used range, detected populated-row count, and non-empty-cell count without exposing cell values. Then use `sheet`, or `sheet + cell_range` (for example `A1:F40`) for a coordinate-preserving targeted read.
- **XLSX correctness boundary**: rows carry explicit row and Excel-column coordinates, blank cells do not shift values, and every truncation or omitted sheet is explicit. Valid OOXML workbooks whose worksheet relationship does not start at `sheet1.xml` are supported. Before `read-excel-file` can materialize gaps, every worksheet member that the pinned decoder can consume is checked against bounded logical rows/cells per sheet and aggregate cells per workbook, including relationships labelled `TargetMode="External"`; tiny sparse archives cannot request an Excel-edge array.
- **PPTX native projection**: slides follow the relationship order declared by the deck, not ZIP filename order; DrawingML text and speaker notes are extracted locally and indexed as `slide:N`. Image OCR, chart data, SmartArt and embedded objects remain explicit future boundaries.
- **Timeout**: `read_document` single-run timeout `readTimeoutMs` (default 120s) so large PDF parses don't rely on a hard-coded value.
- **Scanned-doc notice**: a PDF with no text layer returns an explicit notice instead of an empty string, so the model doesn't mistake it for an empty file.
- **Parse cache**: LRU with a dual budget, keyed on `(targetKey, content sha256, format, sheet, listSheets, cellRange)` — content and range changes invalidate it.
- **Size pre-check**: `stat` first, then reject over `maxFileBytes` with `FS_TOO_LARGE` without reading bytes.
- **Cooperative cancellation**: parses listen to the execution signal and abort on user cancel / session close.
- **Tool-first reading**: the system prompt tells the model to use `read_document` directly and not fall back to Python or shell unless the tool returns an explicit error or unsupported-feature notice.
- **UI projection**: tool results are projected via `presentationMeta` into a `card: 'read'`, reusing the official file-read card (line numbers / highlight / scroll); the model side only receives compact line text.

## Security

- The decoder layer reuses maintained read-only primitives: `pdfjs-dist` for PDF, `fflate + saxen` for DOCX/PPTX ZIP/XML, and pinned `read-excel-file` for XLSX. This plugin owns DOCX paragraph/table/notes projection, PPTX slide/notes projection, spreadsheet ranges, truth boundaries, and the tool protocol.
- ZIP central-directory probing never expands members; member count/name, per-XML size and aggregate XML expansion are capped. XLSX rejects ZIP64, hostile size declarations and unsafe logical worksheet grids before the decoder can allocate from them.
- File reads go through `ctx.fs`, inheriting the session sandbox and fs-observation policy with the same privileges as the built-in read tool. `FileSystem.contains(workspaceRoot, target)` is the authoritative containment check when the session has a cwd; `displayPath` is never treated as an authorization boundary. Model-facing paths are projected only from the caller request into a reusable workspace-relative spelling, and any target or spelling that cannot be represented safely fails closed instead of returning an absolute host path.
- Upload persistence, deletion, quota scanning and TTL sweeping reject pre-existing symlinks and special files below `.dsh-filess`; final creation uses `O_EXCL | O_NOFOLLOW`. Portable Node does not expose a full dirfd/openat chain, so a same-UID process racing ancestor replacement remains an OS-isolation boundary, and quota locking is process-local rather than cross-process.
- The retrieval database stays in a private local directory and must not be synced to cloud storage or committed to Git. The JS fallback is process-local only.
- Upload content is not hard-allowlisted (all extensions allowed by default); the session sandbox is the backstop.

## Install

```sh
dsh plugin --profile web add dsh-files
# restart dsh web
```

## Configuration

```yaml
- id: upload-toolkit
  name: 'dsh-files'
  config:
    maxFileBytes: 25165824        # per-document read byte cap
    readLimit: 800                # default lines per call (cheap pagination)
    sheetRowLimit: 200            # rows kept per worksheet
    maxSheets: 5                  # sheets read per workbook
    cacheEntries: 16              # parse-cache entry count
    cacheMaxBytes: 67108864       # parse-cache byte budget
    maxOutputChars: 24000         # per-call window budget (text full; xlsx 3/4; pdf/docx/pptx 1/2; truncate w/ marker)
    readTimeoutMs: 120000         # read_document single-run timeout
    uploadMaxBytes: 25165824      # per-upload byte cap
    allowedExtensions: []         # upload extension allowlist (empty = all)
    uploadTtlMs: 604800000        # upload retention (7 days)
    sweepIntervalMs: 3600000      # sweep interval
    maxConcurrentUploads: 4       # concurrent upload bodies
    maxUploadBytesPerSession: 536870912 # per-session quota (default 512 MiB; 0 explicitly disables)
    uploadDir: /abs/path          # fallback upload root when there is no sessions service
    trustedHosts: []              # extra trusted upload hosts, e.g. dsh.example.com or dsh.example.com:443 (bare host matches any port); default empty = loopback only
    retrievalEnabled: true        # enable search_documents; read_document remains available when false
    # retrievalIndexDir: /absolute/private/path # optional; omit for $DSH_HOME/dsh-files/index (`~` is not expanded)
    retrievalMaxFiles: 12         # documents per search call
    retrievalMaxResults: 12       # evidence blocks per call
    retrievalBlockChars: 1600     # maximum evidence-block characters
    retrievalMaxBlocksPerDocument: 20000
    retrievalDocumentTtlMs: 2592000000
    retrievalQueryLogEnabled: false # persist model search terms; privacy-first default is off
    retrievalQueryLogTtlMs: 2592000000
    retrievalTimeoutMs: 120000
```

`trustedHosts` means “this reverse-proxy authority is an allowed deployment entry”; it is **not user authentication**. The current official Harness WebServer route does not expose request identity or session ownership to plugins, so this plugin cannot prove that a supplied `x-session-id` belongs to the caller; hashing the directory name does not create authorization. Use loopback-only self-hosting, or an authenticated reverse proxy that also constrains session access. TLS may terminate upstream, but Origin hostname/port authority must still match.

Node.js `>=20.12.0` is required. Node 20 can use the complete but process-local JS retrieval backend; a Harness runtime with `node:sqlite` and FTS5 automatically gets the private persistent backend. The actual selection is shown in tool output.

## Development

```sh
pnpm install
pnpm test          # upload / parse / cache regression
pnpm benchmark:retrieval # 11 synthetic correctness classes on SQLite and JS
pnpm build         # esbuild client bundle
npx tsc --noEmit   # type check
```

## License

MIT
