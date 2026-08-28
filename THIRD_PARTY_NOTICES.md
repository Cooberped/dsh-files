# Third-Party Notices / 第三方软件声明

This document describes the runtime dependency licenses verified from
`package.json`, `pnpm-lock.yaml`, and installed package metadata at release
preparation baseline `ba6cead1b33a5bc53449918350be7618504076bf`. It is an
inventory aid, not legal advice. The lockfile and each installed package's
license text remain authoritative for the exact dependency graph.

本文记录发布准备基线 `ba6cead1b33a5bc53449918350be7618504076bf` 的运行时
依赖许可核验结果。它用于透明披露，不代替法律意见；精确依赖图以 lockfile 和各包
自带许可证为准。

## Project license and lineage / 项目许可证与沿革

The repository's original and modified project code is distributed under the
[MIT License](LICENSE). This Cooberped community fork preserves the copyright
and MIT notice from the upstream `taxueseek/dsh-files` project. Third-party
components remain under their own licenses and are not relicensed as MIT.

## Direct runtime dependencies / 直接运行时依赖

| Package | Resolved version | License | Upstream |
| --- | ---: | --- | --- |
| `fflate` | 0.8.3 | MIT | <https://github.com/101arrowz/fflate> |
| `pdfjs-dist` | 4.10.38 | Apache-2.0, with separately licensed data files described below | <https://github.com/mozilla/pdf.js> |
| `read-excel-file` | 9.3.10 | MIT | <https://gitlab.com/catamphetamine/read-excel-file> |
| `saxen` | 11.1.1 | MIT | <https://github.com/nikku/saxen> |

`read-excel-file` also resolves permissively licensed runtime dependencies in
the lockfile, including `unzipper-esm` 0.13.3 (MIT), `worker-f` 0.1.20 (MIT),
`graceful-fs` 4.2.11 (ISC), and `node-int64` 0.4.0 (MIT). `pdfjs-dist` declares
`@napi-rs/canvas` as an optional MIT-licensed dependency; the installed
platform package varies by operating system and CPU architecture.

Peer dependencies under `@deepseek-ai/*`, `@deepseek-ai/cordis`, and `react`
are supplied by the DeepSeek Harness host. They are not bundled into this
project's npm tarball. Consumers must review the versions and terms supplied by
their Harness installation.

## `pdfjs-dist` fonts and data files / `pdfjs-dist` 字体与数据文件

The `pdfjs-dist` package metadata identifies the package as Apache-2.0, but the
upstream npm package also contains data files with their own notices:

- `standard_fonts/Foxit*.pfb` is accompanied by `LICENSE_FOXIT`, a BSD-style
  three-clause notice from the PDFium authors.
- `standard_fonts/LiberationSans*.ttf` is the unmodified Liberation Sans
  1.07.4 release and is licensed under
  `GPL-2.0-only WITH Liberation font exception`.
- `cmaps/` carries its own upstream `LICENSE` notice.

Those files are **not relicensed under Apache-2.0 or this project's MIT
license**. In the currently resolved `pdfjs-dist@4.10.38`, the accompanying
`LICENSE_LIBERATION` incorrectly contains OFL-1.1 text even though OFL applies
only to Liberation 2.0 and later. Mozilla confirmed and corrected this upstream
in [pdf.js PR #21750](https://github.com/mozilla/pdf.js/pull/21750), merged on
2026-08-10. No npm release containing that correction had been verified at
this release-candidate baseline, so this notice records the actual 1.07.4
license rather than repeating the mismatched file.

The `dsh-files` PDF parser imports `pdfjs-dist/legacy/build/pdf.mjs`, performs
text-layer extraction, sets `useSystemFonts: true`, and does not configure a
`standardFontDataUrl` or `cMapUrl`. The `dsh-files` npm tarball uses a project
file allowlist and does **not embed or copy the `pdfjs-dist` standard-font or
CMap files into the tarball**. Installing dependencies may place the separate
`pdfjs-dist` package and its assets on the consumer's disk; anyone who later
redistributes those upstream assets must preserve their corresponding license
texts and notices.

这里的关键边界是：`pdfjs-dist` 根包标注 Apache-2.0，并不意味着其中字体被重新
许可为 Apache-2.0；但本项目自己的 npm tarball 也没有复制或内嵌这些字体。依赖
安装后，字体仍属于独立的 `pdfjs-dist` 包，并继续受各自 BSD 或
`GPL-2.0-only WITH Liberation font exception` 条款约束。当前上游 npm 包内把
Liberation 1.07.4 错配为 OFL-1.1 的许可证文件，不能作为本项目的许可依据。

## Distribution checklist / 分发检查

Before every public release:

1. regenerate and review the production dependency tree from the locked
   install;
2. confirm `npm pack --dry-run` does not unexpectedly bundle dependency assets;
3. include `LICENSE` and this file in the published package;
4. update this notice for dependency, bundling, parser, font, or CMap changes;
5. retain all third-party license files when redistributing third-party assets.

For the first public npm release, either upgrade to a `pdfjs-dist` version that
contains the merged #21750 correction and rerun focused PDF tests, or retain
this explicit disclosure and obtain a maintainer's documented license-risk
acceptance. Never describe the Liberation 1.07.4 fonts as OFL-1.1.
