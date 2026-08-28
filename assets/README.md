# Asset provenance register / 素材来源登记

Every visual referenced by the current README must have a documented source,
license decision, privacy review, and confirmation date. Repository history
alone is not proof of authorship or permission.

当前 README 引用的每一项视觉素材，都必须记录来源、许可判断、隐私检查和确认日期。
仅存在于 Git 历史中，不等于已经证明创作权或获得使用许可。

## Status meanings / 状态定义

- `CONFIRMED`: source/creation method, license or permission, privacy review,
  third-party mark treatment, confirmer, and date are recorded.
- `PENDING`: one or more facts are missing. This blocks a public release that
  includes or references the asset.
- `REJECTED / REMOVED`: the asset must not appear in the current tree or README.

## Current original assets / 当前原创素材

All current assets are deterministic SVG markup created directly for this
repository on 2026-08-28. They embed no external raster image, font file, logo,
third-party artwork, screenshot, user document, model output, credential,
private path, personal data, or hidden metadata. System font-family names are
CSS fallbacks only; no font software is bundled.

The `*.zh.svg` files are Simplified-Chinese counterparts of the three English
diagrams: identical geometry and palette, translated copy, label boxes
recomputed for CJK glyph width, and a CJK font-family fallback list.

当前素材均于 2026-08-28 以确定性 SVG 代码直接为本仓库创建。文件不嵌入外部图片、
字体文件、Logo、第三方作品、截图、用户文档、模型输出、凭据、私有路径、个人信息或
隐藏元数据；`font-family` 只是系统字体回退声明，并未打包字体软件。

`*.zh.svg` 是三张英文图的简体中文版：几何与配色完全一致，文案为翻译版本，标签框
宽度按中文字宽重算，并补充了 CJK font-family 回退列表。

| Asset | SHA-256 | Purpose | License/status |
| --- | --- | --- | --- |
| `readme/hero.svg` | `40216c2aea8ec85aa8cbfd00d0621b69e60929f40c0037f48706bdb482f3e852` | Project identity and four-capability overview | Repository-original SVG; contributed under MIT; `CONFIRMED` |
| `readme/architecture.svg` | `f78a71239c37320af50549449862eab312b130c9ccbc21395ff5f925f7f10595` | Composer → local ingest → private retrieval → model tools, plus native vision branch | Repository-original SVG; contributed under MIT; `CONFIRMED` |
| `readme/evidence-loop.svg` | `4df0cd67ac480bf275ed3a07bc1a3a7d21575a01193e6b2f0dcbdcdfb95dedd5` | Inventory → retrieve → expand → answer workflow | Repository-original SVG; contributed under MIT; `CONFIRMED` |
| `readme/hero.zh.svg` | `65979efc25efc47b3433326140b8f8d7d96dd93aefa46eb27fa333c1fcf33f45` | Simplified-Chinese hero for `README.zh.md` | Repository-original SVG; contributed under MIT; `CONFIRMED` |
| `readme/architecture.zh.svg` | `7d60d91b1ee1c080d505514cd8f9a440b1ad5b526b725308196a2b7e44f9dea8` | Simplified-Chinese architecture diagram for `README.zh.md` | Repository-original SVG; contributed under MIT; `CONFIRMED` |
| `readme/evidence-loop.zh.svg` | `cbcdfd4b4d6e5850016f226554dea38b03fa7c81a9ed34ba2e00abc6191f3343` | Simplified-Chinese evidence-loop diagram for `README.zh.md` | Repository-original SVG; contributed under MIT; `CONFIRMED` |

Confirmation / 确认：

- Maintainer identity / 维护者身份：`Cooberped`
- Creation and review date / 创建与复核日期：`2026-08-28`
- Privacy review / 隐私检查：`PASS` — synthetic labels only; no real user or
  business data.
- Trademark review / 商标检查：`PASS` — product names appear only as
  nominative explanatory text in README prose, diagram labels, or SVG
  accessibility metadata. No third-party logo or stylized brand mark is drawn.
- License / 许可：project MIT license.

## Removed inherited assets / 已移除的继承素材

The following files entered through the upstream `taxueseek/dsh-files` history.
Git history identified the commits and bytes, but did not prove the screenshot
creator, permission for visible UI/brand material, or a privacy review.
Cooberped therefore removed the files and every current README reference rather
than treating public Git history as an implied license.

以下文件继承自 `taxueseek/dsh-files`。Git 历史只能识别提交和文件字节，无法证明
截图创作者、画面 UI/品牌素材使用权或隐私审查。Cooberped 因此删除文件及当前
README 引用，而没有把“曾经公开提交”误当作默认授权。

| Removed asset | Historical SHA-256 | First recorded commit | Final decision |
| --- | --- | --- | --- |
| `readme/hero.svg` (inherited version) | `9dcc309978e0ae50e86988c13efca843ff0d0be9dcce4208976ff811745e1af1` | `888b9ea8e7d86ffdc0054afdbc88704133f6c187` | Replaced by repository-original SVG |
| `composer.png` | `656394140db9c7e065e2231b3a12076eee4ac50bc1d2d30597bbc19448db1d2f` | `0a2e483210b9be17e9bf8e875951f7252c68d767` | `REJECTED / REMOVED` |
| `upload-folder-images.png` | `147beafade2cfea0df5ab63a61fe9b82f9e76f93b49b01c9df03971538d67a43` | `73f1a42269ce04b3cca601e7e813b9a19a050050` | `REJECTED / REMOVED` |
| `native-image-dialog.png` | `8f10d12e36a6951a4deaa43ae0c1a96ac315d469f84e5a87738b00a09da10e2c` | `73f1a42269ce04b3cca601e7e813b9a19a050050` | `REJECTED / REMOVED` |
| `upload-entry.png` | `227680f76a74844b5a4fcb079c859eb3f547ba5cbfb0569ff58e0e4df7778583` | `a5d8d3452b6b9f00396ba976ca416d6f07acf78c` | `REJECTED / REMOVED` |

The deleted bytes remain visible in historical commits because this project
preserves upstream Git history. They are not present in the current tree and
are not referenced by current documentation.

已删除字节仍会因为保留上游 Git 历史而存在于旧 commit 中；它们不在当前工作树中，
也不再被当前文档引用。

## Rule for future additions / 后续新增规则

A pull request that adds a visual asset must update this file in the same
change with:

1. creator or capture owner;
2. original source and creation/capture date;
3. applicable license or explicit permission;
4. confirmation that no credential, private path, user document, personal data,
   or confidential model output is visible;
5. treatment of third-party trademarks and UI screenshots;
6. confirmer's GitHub identity and date.

Missing evidence leaves the asset `PENDING` and blocks a release that includes
or references it.
