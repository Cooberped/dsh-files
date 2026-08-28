<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/hero.svg" width="100%" alt="dsh-files turns local files into versioned evidence through upload, retrieval, coordinate reads, and native vision.">
</p>

# dsh-files

**A compact, independent community plugin that gives DeepSeek Harness a complete file-to-evidence loop.**

Upload several files or a folder from the Web composer, keep parsing and retrieval local, let the model search compact evidence, and expand only the exact page, slide, line range, or spreadsheet range it needs. Raster images stay on Harness' native vision path.

> [!IMPORTANT]
> **Source beta — not published to npm yet.** The repository is ready for local source use, but `@cooberped/dsh-files@beta` does not exist on npm at this time. Use the [source install](#install-from-source) below. Do not treat the future npm command as currently available.

| Status | Current position |
| --- | --- |
| Project | Public source beta, independently maintained by Cooberped |
| Harness baseline | Tested against npm `@deepseek-ai/dsh@0.1.1-rc.2` with the `web` profile |
| Runtime acceptance target | OpenCode Go — DeepSeek V4 Flash |
| npm | **Not published**; package metadata targets `@cooberped/dsh-files@0.6.0-beta.1`; scope ownership, trusted publishing, and the first-release license gate remain open |
| Compatibility | Newer Harness source trains are not claimed compatible until separately tested |

This is **not an official DeepSeek plugin** and is not affiliated with or endorsed by DeepSeek. It is also not a clean-room rewrite: the MIT-licensed history of [taxueseek/dsh-files](https://github.com/taxueseek/dsh-files) is retained, while Cooberped independently develops the retrieval, coordinate, security, performance, and release layers described here.

## Why this plugin exists

A file picker alone does not make an agent good at documents. If every file is pasted into the prompt, long workbooks and meeting records consume context before the model knows what matters. If the model sees only a local path, it often falls back to Python or shell exploration and repeats expensive reads.

`dsh-files` uses a smaller loop:

1. **Upload once** into the active session workspace.
2. **Index locally** without placing full documents in model context.
3. **Retrieve compact evidence** for a concrete question.
4. **Expand a versioned coordinate** only when more context is needed.
5. **Answer from evidence**, or say that evidence was not found.

This is the main design contribution: files become addressable evidence rather than prompt baggage.

## What this project adds

| Design choice | What it changes |
| --- | --- |
| **One dual-face bundle** | One Harness bundle mounts both the Web composer surface and the host-side model tools. |
| **Evidence-first tool loop** | `search_documents` inventories or retrieves; `read_document` expands exact evidence instead of repeatedly scanning whole files. |
| **Reversible, versioned coordinates** | Evidence points to a PDF page, PPTX slide, text/DOCX line range, or quoted XLSX `Sheet!Range`. A stale content/schema version fails closed. |
| **Order-aware Chinese retrieval** | CJK runs use overlapping bigrams and phrase matching; single characters get a bounded substring fallback; ASCII tokens such as `Q3` remain whole. |
| **Runtime-adaptive index** | The actual Harness runtime is probed for `node:sqlite` and FTS5. Unsupported runtimes fall back to a dependency-free in-memory JS backend with the same result contract. |
| **Defensive local ingestion** | Formats are detected from bytes, OOXML expansion and worksheet grids are bounded, paths stay inside the session workspace, and truncation is explicit. |
| **Small package-owned surface** | The release gate keeps the package-owned unpacked tarball under 1 MiB and excludes benchmarks, source, tests, screenshots, and vendored dependencies. Installed dependency size is separate. |

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/architecture.svg" width="100%" alt="dsh-files architecture: composer, local ingest, private retrieval, model tools, and native vision branch.">
</p>

## Capabilities

### Composer and upload

- Paperclip **multi-select**, whole-folder selection, and page-level drag and drop.
- Finder multi-selection merges `DataTransfer.items` and `DataTransfer.files` so mixed document batches are not silently reduced to the first recognized file.
- Documents are captured before Harness' image-only drop handler; pure JPEG/PNG/WebP/GIF drops stay on the native image path.
- Bounded parallel uploads (default `4`); one file failure does not cancel the rest of the batch.
- Compact, byte-sniffed file cards with `uploading`, `AI-readable`, and `failed` states.
- `@` candidates include both uploaded files and workspace files, projected as workspace-relative paths rather than host absolute paths.
- Per-session storage quota, SHA-256 deduplication, TTL cleanup, safe file-name normalization, and recursive folder cleanup.

### Local retrieval

- Call `search_documents(file_paths)` without `query` to build/update the private index and return a compact inventory.
- Add a short `query` to receive ranked evidence blocks with `format`, `coordinate`, and `version`.
- SQLite FTS5 is used only after a startup capability probe succeeds; otherwise the JS memory backend is selected explicitly.
- Query persistence is disabled by default.
- Content versions include the source hash plus parser/block schema identity, so content or projection changes invalidate old evidence.

### Exact document reads

- `read_document` detects the real format from content and reads text, PDF, DOCX, XLSX, or PPTX without Python.
- Long output is paged and character-bounded; every truncation is visible.
- XLSX supports workbook inventory, one-based sheet selection, coordinate-preserving A1 ranges, merged headers, hidden/sparse sheets, and explicit detected-value counts.
- PPTX follows presentation relationship order and extracts DrawingML text plus speaker notes.
- Search coordinates can be passed back with the same version for exact expansion.
- The system prompt tells the model to use these tools first and only fall back to Python/shell after an explicit error or unsupported-feature notice.

### Native vision handoff

- JPEG, PNG, WebP, and GIF uploads use Harness' native composer attachment rail.
- Images are serialized through the provider-neutral base64 `image_url` path.
- Any selected model must still declare image input support; the plugin does not make a text-only model visual.

## Supported formats and honest boundaries

| Input | Local projection | Stable coordinate | Current boundary |
| --- | --- | --- | --- |
| Text | UTF-8, UTF-16 BOM, high-confidence BOM-less UTF-16, GB18030 | `line:S-E` and optional `chars:S-E` | Other encodings and binary files are rejected |
| PDF | Text-layer extraction, page-preserving projection | `page:N` with optional local line/character range | No OCR for scanned/image-only pages |
| DOCX | Main document, paragraphs, tables, headers, footers, footnotes, endnotes | `line:S-E` and optional `chars:S-E` | No image OCR; layout fidelity is not a Word renderer |
| XLSX | Sheet inventory, cell values, ranges, row/column coordinates | quoted `Sheet!A1:F40` | No formula calculation, chart/shape interpretation, or macro execution |
| PPTX | Slide-order DrawingML text and speaker notes | `slide:N` with optional local line/character range | No slide-image OCR, chart data, SmartArt, animation, or embedded-object extraction |
| JPEG/PNG/WebP/GIF | Native Harness image attachment | Harness attachment identity | Requires a vision-capable model; not parsed by `read_document` |

## Install from source

Requirements:

- DeepSeek Harness CLI with the `web` profile; the validated baseline is npm `@deepseek-ai/dsh@0.1.1-rc.2`.
- Node.js `>=20.12.0`.
- `pnpm` available on `PATH`.

```sh
git clone https://github.com/Cooberped/dsh-files.git
cd dsh-files
pnpm install --frozen-lockfile
pnpm build

# Official Harness profile plugin form: links this checkout into the web profile.
dsh plugin --profile web add .

# Confirm that the @cooberped/dsh-files bundle layer is present.
dsh --profile web --dump-config

# Restart after installing or rebuilding.
dsh web
```

The local install is a link to this checkout. After changing branches or pulling updates, run `pnpm install --frozen-lockfile`, `pnpm build`, and restart `dsh web`.

Remove it with:

```sh
dsh plugin --profile web remove @cooberped/dsh-files
```

The profile/plugin contract follows the official [DeepSeek Harness plugin reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) and [bundle publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

### Future npm beta

Only after the repository release gates and npm trusted publishing are complete:

```sh
dsh plugin --profile web add @cooberped/dsh-files@beta
# restart dsh web
```

That command is intentionally documented as **future**, not current availability.

## Use it

1. Open the Harness Web composer.
2. Select several files with the paperclip, choose a folder, or drop files on the page.
3. Confirm that every intended file has its own card and an `AI-readable` state.
4. Ask a concrete question. The model should call the tools automatically.

Useful prompts:

```text
Index these three files first. Do not summarize them yet.
```

```text
Across these files, find the definition and formula for the Q3 retention metric.
Give the source file and exact page, slide, line range, or Sheet!Range for every claim.
```

```text
Compare the meeting decision with the workbook target.
If the documents do not contain enough evidence, say what is missing instead of guessing.
```

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/evidence-loop.svg" width="100%" alt="Recommended model evidence loop: inventory, retrieve, expand, and answer from version-checked evidence.">
</p>

## Model tool contract

### `search_documents`

Use this before reading attached documents.

| Input | Purpose |
| --- | --- |
| `file_paths` | One or more relevant PDF/DOCX/XLSX/PPTX/text paths |
| no `query` | Index changed content and return a compact inventory |
| `query` | Return ranked evidence blocks for a short keyword or exact phrase |

Every evidence result includes enough information for controlled follow-up:

- projected workspace-relative `path`;
- detected `format`;
- evidence `text`;
- stable `coordinate`;
- parser/block-schema-bound `version`;
- backend/status notices without leaking local diagnostic paths.

Zero recall is not permission to guess. The tool directs the model to retry with different terms, read sequentially when justified, or report that the files do not contain evidence.

### `read_document`

Use this to expand a selected result or to perform a deliberate legacy paged read.

| Input | Purpose |
| --- | --- |
| `file_path` | Session-resolved document path |
| `coordinate` + `version` | Exact expansion of evidence returned by `search_documents` |
| `offset` + `limit` | Controlled sequential pagination |
| `list_sheets` | XLSX structure inventory without cell values |
| `sheet` + optional `cell_range` | One worksheet or A1 range |

When `coordinate` is supplied, `version` is mandatory and checked before document content is returned. A changed file or changed projection contract must be searched again.

## Storage and privacy

There are two local stores with different purposes:

| Store | Default | Contains | Lifecycle |
| --- | --- | --- | --- |
| Uploads | `<session-workspace>/.dsh-filess/<storageKey>/` | Uploaded file bytes | Per-session quota, SHA-256 dedup, default 7-day TTL sweep |
| Retrieval index | `$DSH_HOME/dsh-files/index` | Search projection, coordinates, versions; queries only when explicitly enabled | Private permissions, document/query TTL, JS memory fallback when persistence is unavailable |

Important privacy boundary:

- Parsing and indexing are local to the Harness host.
- The selected evidence returned by tools becomes part of the model conversation and may be sent to the configured model provider.
- Native image attachments are also sent to the selected vision provider.
- The plugin does not make an external parsing-service request of its own.
- Do not sync the retrieval directory to cloud storage or commit it to Git.

## Security model

- **Byte-level truth:** extensions are hints only. PDF headers and OOXML ZIP members determine the parser; known foreign binaries and spoofed files are rejected.
- **Bounded OOXML:** ZIP member count/name, declared XML sizes, aggregate XML expansion, workbook rows/cells, and sparse-sheet dimensions are capped before parser allocation.
- **Workspace containment:** reads go through `ctx.fs`; paths must remain in the active session workspace when a session cwd exists.
- **Safe upload storage:** pre-existing symlinks/special files are rejected; creation uses exclusive/no-follow flags where supported; quotas and deletion remain fail-closed.
- **Network default:** upload/workspace endpoints trust loopback and same-origin checks by default. `trustedHosts` allows a deployment-controlled reverse proxy.

`trustedHosts` is **not authentication**. The current Harness WebServer plugin contract does not prove that a supplied session ID belongs to the caller. Do not expose this plugin as an unauthenticated public multi-tenant upload service. Use loopback-only self-hosting or an authenticated proxy that also constrains session access.

## Configuration

The bundle ships conservative defaults in [`cordis.patch.yml`](cordis.patch.yml). Harness applies user profile overlays after bundle layers; inspect the composed result before boot:

```sh
dsh --profile web --dump-config
```

Common settings:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxFileBytes` | 24 MiB | Maximum bytes for one document read |
| `uploadMaxBytes` | 24 MiB | Maximum bytes for one upload body |
| `maxUploadBytesPerSession` | 512 MiB | Session upload quota; `0` explicitly disables the quota |
| `readLimit` | 2,000 in the bundled patch; schema fallback 800 | Maximum lines returned by one `read_document` call |
| `maxOutputChars` | 24,000 | Base character window; narrative formats receive smaller format-specific windows |
| `maxConcurrentUploads` | 4 | Admitted upload bodies |
| `uploadTtlMs` | 7 days | Uploaded-file retention |
| `retrievalEnabled` | `true` | Enables `search_documents`; `read_document` remains available when false |
| `retrievalMaxFiles` | 12 | Files in one search call |
| `retrievalMaxResults` | 12 | Evidence blocks returned |
| `retrievalQueryLogEnabled` | `false` | Persist normalized model queries for local tuning |
| `trustedHosts` | `[]` | Additional reverse-proxy authorities; empty means loopback only |

Less common settings and their authoritative defaults live in [`src/index.ts`](src/index.ts). An explicit `retrievalIndexDir` must be an absolute private path; `~` is not expanded.

### Runtime backend selection

The package accepts Node.js `>=20.12.0`.

- A persistent retrieval index requires the actual Harness runtime to provide Node.js `>=22.5.0`, `node:sqlite`, and FTS5.
- Node 20 or any failed probe uses the complete but process-local JS backend.
- Tool output reports the selected backend; the fallback is a supported mode, not a silent partial success.

## Known limits

- Scanned PDFs and images embedded in office files are not OCR'd.
- Office layout is projected into text/coordinates; it is not rendered pixel-for-pixel.
- XLSX formulas are not calculated and macros never execute.
- PPTX charts, SmartArt, animations, and embedded objects are not interpreted.
- Upload quota locking is process-local, not a cross-process transaction.
- Portable Node does not expose a complete dirfd/openat chain; a hostile same-UID process racing ancestor replacement remains an OS-isolation boundary.
- Compatibility is deliberately pinned to the tested Harness prerelease train until a newer runtime passes the same acceptance workflow.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm benchmark:retrieval
pnpm license:check
pnpm package:check

# Stable final candidate only:
pnpm release:check
```

The repository benchmark uses deterministic synthetic PDF/DOCX/XLSX/PPTX fixtures. Real business documents, answer sets, and model outputs must stay outside the repository; see [`benchmark/README.md`](benchmark/README.md).

`release:check` covers type checking, both bundles, focused regression tests, dual-backend retrieval correctness, license policy, and the npm tarball contract.

## Contributing

Issues and pull requests are welcome. Contributions are **reviewed and merged by maintainers after required checks**; GitHub does not merge community code automatically.

Before opening a PR:

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and sign off commits for DCO.
2. Add focused tests for behavior changes.
3. Run the smallest relevant checks locally.
4. Keep real documents, credentials, private paths, and model outputs out of Git.
5. Record every new visual asset in [`assets/README.md`](assets/README.md).

Security reports follow [`SECURITY.md`](SECURITY.md). Release ownership and provenance gates are documented in [`RELEASING.md`](RELEASING.md).

## License, lineage, and marks

Project code and the original SVG documentation graphics are licensed under the [MIT License](LICENSE). Upstream history and copyright notices are retained. Dependency and bundled-data notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

DeepSeek, DeepSeek Harness, OpenCode Go, and other third-party names or marks belong to their respective owners and are used only to identify compatibility or a test target. See [`assets/README.md`](assets/README.md) for asset provenance.
