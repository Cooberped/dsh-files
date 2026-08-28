<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

> [!IMPORTANT]
> **This repository has moved to [Cooberped/dsh-evidence](https://github.com/Cooberped/dsh-evidence).**
> Development continues there under the npm name `@cooberped/dsh-evidence`. This
> copy is archived and will not receive updates. The full commit history,
> including the upstream `taxueseek/dsh-files` lineage, came along unchanged.

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/hero.svg" width="100%" alt="dsh-files turns local files into versioned evidence through upload, retrieval, coordinate reads, and native vision.">
</p>

# dsh-files

**Attach files in DeepSeek Harness and let the model actually read them.**

Upload files or a whole folder from the Web composer. Parsing and indexing stay on your machine. The model searches for compact evidence and expands only the exact page, slide, line range or spreadsheet range it needs — instead of pasting whole documents into the prompt or shelling out to Python. Raster images stay on Harness' native vision path.

> [!IMPORTANT]
> **Source beta — not published to npm yet.** `@cooberped/dsh-files@beta` does not exist on npm at this time. Use the [source install](#install-from-source) below.

## How it works

1. **Upload once** into the active session workspace.
2. **Index locally** — no full document enters the model context.
3. **Retrieve compact evidence** for a concrete question.
4. **Expand a versioned coordinate** only when more context is needed.
5. **Answer from evidence**, or say the evidence was not found.

Files become addressable evidence rather than prompt baggage. That is the whole design.

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/architecture.svg" width="100%" alt="dsh-files architecture: composer, local ingest, private retrieval, model tools, and native vision branch.">
</p>

## Install from source

You need the DeepSeek Harness CLI with the `web` profile (validated baseline: npm `@deepseek-ai/dsh@0.1.1-rc.2`), Node.js `>=20.12.0`, and `pnpm` on `PATH`.

```sh
git clone https://github.com/Cooberped/dsh-files.git
cd dsh-files
pnpm install --frozen-lockfile
pnpm build

dsh plugin --profile web add .      # link this checkout into the web profile
dsh --profile web --dump-config     # confirm the bundle layer is present
dsh web                             # restart
```

The install is a link to this checkout: after pulling updates, re-run `pnpm install --frozen-lockfile && pnpm build` and restart. Remove it with `dsh plugin --profile web remove @cooberped/dsh-files`.

<details>
<summary>Future npm beta — not available yet</summary>

Once the repository release gates and npm trusted publishing are complete, installation becomes:

```sh
dsh plugin --profile web add @cooberped/dsh-files@beta
# restart dsh web
```

This is documented as a **future** command. It does not work today.

The profile/plugin contract follows the official [Harness plugin reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) and [bundle publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

</details>

## Use it

1. Open the Harness Web composer.
2. Add files: paperclip for multi-select, the folder button for a directory, or drop anything on the page.
3. Check that every intended file has its own card showing `AI-readable`.
4. Ask a concrete question — the model calls the tools on its own.

Prompts that work well:

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

## The two tools

| | `search_documents` | `read_document` |
| --- | --- | --- |
| Use it to | find **where** the answer is | read **what** is at a place |
| Key inputs | `file_paths`, optional short `query` | `file_path` + `coordinate`/`version`, or `offset`/`limit`, or `sheet`/`cell_range`/`list_sheets` |
| No `query` | indexes changed content and returns a compact inventory — good for "read these first" | — |
| Returns | ranked evidence blocks, each with `path`, `format`, `text`, `coordinate` and `version` | a paged window of the document, or one coordinate expanded exactly |

Two rules hold the loop together:

- **Coordinates carry a version** (source hash + parser/block schema). Supplying a `coordinate` makes `version` mandatory, and it is checked before any content is returned. Edit the file and the old coordinate fails loudly instead of quietly reading the wrong lines.
- **Zero recall is not permission to guess.** The tool tells the model to retry with different terms, read sequentially when justified, or report that the files contain no evidence.

## Formats and honest boundaries

| Input | Local projection | Stable coordinate | Current boundary |
| --- | --- | --- | --- |
| Text | UTF-8, UTF-16 BOM, high-confidence BOM-less UTF-16, GB18030 | `line:S-E`, optional `chars:S-E` | Other encodings and binary files are rejected |
| PDF | Text-layer extraction, page-preserving | `page:N`, optional local line/character range | No OCR for scanned or image-only pages |
| DOCX | Body, paragraphs, tables, headers, footers, footnotes, endnotes | `line:S-E`, optional `chars:S-E` | No image OCR; not a pixel-faithful Word renderer |
| XLSX | Sheet inventory, cell values, ranges, row/column coordinates | quoted `Sheet!A1:F40` | No formula calculation, chart/shape interpretation, or macro execution |
| PPTX | Slide-order DrawingML text and speaker notes | `slide:N`, optional local line/character range | No slide-image OCR, chart data, SmartArt, animation, or embedded objects |
| JPEG/PNG/WebP/GIF | Native Harness image attachment | Harness attachment identity | Needs a vision-capable model; not parsed by `read_document` |

The format is decided from the bytes, never the extension — an executable renamed to `.pdf` is rejected. Long output is paged and character-bounded, and every truncation is visible.

<details>
<summary><b>Capability details</b> — composer, retrieval, reads, vision handoff</summary>

**Composer and upload**

- Paperclip multi-select, whole-folder selection, and page-level drag and drop.
- Finder multi-selection merges `DataTransfer.items` and `DataTransfer.files`, so a mixed batch is not silently reduced to the first recognized file.
- Documents are captured before Harness' image-only drop handler; pure JPEG/PNG/WebP/GIF drops stay on the native image path.
- Bounded parallel uploads (default `4`); one failure does not cancel the batch.
- Byte-sniffed file cards with `uploading` / `AI-readable` / `failed` states.
- `@` candidates cover uploaded *and* workspace files, projected as workspace-relative paths rather than host absolute paths.
- Per-session quota, SHA-256 dedup, TTL cleanup, safe file-name normalization, recursive folder cleanup.

**Local retrieval**

- CJK runs are indexed as overlapping bigrams and queried as phrases, so `流程绩效` does not match a block containing only `绩效流程`. Single characters use a bounded substring fallback; ASCII tokens such as `Q3` stay whole.
- SQLite FTS5 is used only after a startup capability probe succeeds; otherwise the JS memory backend is selected explicitly and the tool result says so.
- Query persistence is off by default.

**Exact document reads**

- XLSX supports workbook inventory, one-based sheet selection, coordinate-preserving A1 ranges, merged headers, hidden/sparse sheets, and explicit detected-value counts.
- PPTX follows presentation relationship order, not ZIP filename order.
- The system prompt tells the model to use these tools first and fall back to Python/shell only after an explicit error or unsupported-feature notice.

**Native vision handoff**

- JPEG/PNG/WebP/GIF use Harness' native composer attachment rail and the provider-neutral base64 `image_url` path.
- The selected model must still declare image input support; this plugin does not make a text-only model visual.

</details>

## Configuration

The bundle ships conservative defaults in [`cordis.patch.yml`](cordis.patch.yml). Harness applies user profile overlays after bundle layers, so inspect the composed result before boot:

```sh
dsh --profile web --dump-config
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxFileBytes` | 24 MiB | Maximum bytes for one document read |
| `uploadMaxBytes` | 24 MiB | Maximum bytes for one upload body |
| `maxUploadBytesPerSession` | 512 MiB | Session upload quota; `0` explicitly disables it |
| `readLimit` | 2,000 in the bundled patch; schema fallback 800 | Maximum lines returned by one `read_document` call |
| `maxOutputChars` | 24,000 | Base character window; narrative formats get smaller format-specific windows |
| `maxConcurrentUploads` | 4 | Admitted upload bodies |
| `uploadTtlMs` | 7 days | Uploaded-file retention |
| `retrievalEnabled` | `true` | Enables `search_documents`; `read_document` remains available when false |
| `retrievalMaxFiles` / `retrievalMaxResults` | 12 / 12 | Files per search call / evidence blocks returned |
| `retrievalQueryLogEnabled` | `false` | Persist normalized model queries for local tuning |
| `trustedHosts` | `[]` | Additional reverse-proxy authorities; empty means loopback only |

Less common settings and their authoritative defaults live in [`src/index.ts`](src/index.ts). An explicit `retrievalIndexDir` must be an absolute private path; `~` is not expanded.

**Runtime backend.** The package accepts Node.js `>=20.12.0`. A persistent retrieval index additionally requires the actual Harness runtime to provide Node.js `>=22.5.0`, `node:sqlite` and FTS5; Node 20 or any failed probe uses the complete but process-local JS backend. Tool output reports the selected backend — the fallback is a supported mode, not a silent partial success.

## Security and privacy

- **Byte-level truth.** Extensions are hints only. PDF headers and OOXML ZIP members decide the parser; known foreign binaries and spoofed files are rejected.
- **Bounded OOXML.** ZIP member count and name length, declared XML sizes, aggregate XML expansion, workbook rows/cells and sparse-sheet dimensions are all capped before parser allocation.
- **Workspace containment.** Reads go through `ctx.fs`; when a session cwd exists, the target must stay inside the active session workspace.
- **Safe upload storage.** Pre-existing symlinks and special files are rejected; creation uses exclusive/no-follow flags where supported; quotas and deletion fail closed.
- **Loopback by default.** Upload and workspace endpoints require a loopback host and same-origin checks. `trustedHosts` exists only for a deployment-controlled reverse proxy.

> `trustedHosts` is **not authentication.** The current Harness WebServer plugin contract cannot prove that a supplied session ID belongs to the caller. Do not expose this plugin as an unauthenticated public multi-tenant upload service. Use loopback-only self-hosting, or an authenticated proxy that also constrains session access.

<details>
<summary><b>Where data lives, and what leaves the machine</b></summary>

| Store | Default | Contains | Lifecycle |
| --- | --- | --- | --- |
| Uploads | `<session-workspace>/.dsh-filess/<storageKey>/` | Uploaded file bytes | Per-session quota, SHA-256 dedup, default 7-day TTL sweep |
| Retrieval index | `$DSH_HOME/dsh-files/index` | Search projection, coordinates, versions; queries only when explicitly enabled | Private permissions, document/query TTL, JS memory fallback when persistence is unavailable |

- Parsing and indexing are local to the Harness host; the plugin makes no external parsing request of its own.
- The evidence a tool returns **does** enter the conversation and may be sent to your configured model provider. Native image attachments are also sent to the selected vision provider.
- Do not sync the retrieval directory to cloud storage, and do not commit it to Git.

</details>

<details>
<summary><b>Known limits</b> — what this deliberately does not do</summary>

- Scanned PDFs and images embedded in office files are not OCR'd.
- Office layout is projected into text and coordinates, not rendered pixel-for-pixel.
- XLSX formulas are not calculated and macros never execute.
- PPTX charts, SmartArt, animations and embedded objects are not interpreted.
- Upload quota locking is process-local, not a cross-process transaction.
- Portable Node exposes no complete dirfd/openat chain, so a hostile same-UID process racing ancestor replacement remains an OS-isolation boundary.
- Compatibility is pinned to the tested Harness prerelease train until a newer runtime passes the same acceptance workflow.

</details>

## Project status

| | |
| --- | --- |
| Project | Public source beta, independently maintained by Cooberped |
| Harness baseline | Tested against npm `@deepseek-ai/dsh@0.1.1-rc.2` with the `web` profile |
| Runtime acceptance target | OpenCode Go — DeepSeek V4 Flash |
| npm | **Not published.** Package metadata targets `@cooberped/dsh-files@0.6.0-beta.1`; scope ownership, trusted publishing and the first-release license gate remain open |
| Compatibility | Newer Harness source trains are not claimed compatible until separately tested |

This is **not an official DeepSeek plugin** and is not affiliated with or endorsed by DeepSeek. It is also not a clean-room rewrite: the MIT-licensed history of [taxueseek/dsh-files](https://github.com/taxueseek/dsh-files) is retained, while Cooberped independently develops the retrieval, coordinate, security, performance and release layers described here.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm benchmark:retrieval
pnpm license:check
pnpm package:check

pnpm release:check   # everything above, for a final candidate
```

`release:check` covers type checking, both bundles, focused regression tests, dual-backend retrieval correctness, license policy and the npm tarball contract. The benchmark uses deterministic synthetic PDF/DOCX/XLSX/PPTX fixtures — real business documents, answer sets and model outputs stay outside the repository (see [`benchmark/README.md`](benchmark/README.md)).

## Contributing

Issues and pull requests are welcome. Contributions are **reviewed and merged by maintainers after required checks**; GitHub does not merge community code automatically.

Before opening a PR: read [`CONTRIBUTING.md`](CONTRIBUTING.md) and sign off commits for DCO; add focused tests for behavior changes; run the smallest relevant checks locally; keep real documents, credentials, private paths and model outputs out of Git; and record every new visual asset in [`assets/README.md`](assets/README.md).

Security reports follow [`SECURITY.md`](SECURITY.md). Release ownership and provenance gates are in [`RELEASING.md`](RELEASING.md).

## License, lineage and marks

Project code and the original SVG documentation graphics are licensed under the [MIT License](LICENSE). Upstream history and copyright notices are retained. Dependency and bundled-data notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

DeepSeek, DeepSeek Harness, OpenCode Go and other third-party names or marks belong to their respective owners and are used only to identify compatibility or a test target. Asset provenance is recorded in [`assets/README.md`](assets/README.md).
