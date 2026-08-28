<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/hero.svg" width="100%" alt="dsh-files 将本地文件经过上传、检索和带版本坐标回读，转化为可追溯证据，并保留原生视觉链路。">
</p>

# dsh-files

**在 DeepSeek Harness 里传文件，让模型真的能读。**

在 Web 输入框上传文件或整个文件夹。解析和索引都留在本机。模型先检索紧凑证据，再按需展开准确的页码、幻灯片、行区间或表格范围——而不是把全文塞进 prompt，也不用退回 Python 遍历。栅格图片继续走 Harness 原生视觉链路。

> [!IMPORTANT]
> **当前是源码 Beta，尚未发布 npm。** npm 上目前不存在 `@cooberped/dsh-files@beta`，请使用下方[源码安装](#从源码安装)。

## 它怎么工作

1. **只上传一次**，文件落在当前会话工作区。
2. **在本地建索引**——不把全文预先塞进模型上下文。
3. **围绕具体问题检索紧凑证据**。
4. **只在需要时展开带版本的准确坐标**。
5. **基于证据回答**；没有证据就明确说明。

文件不再只是 prompt 负担，而成为可寻址、可回读的证据。整个设计就是这一件事。

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/architecture.svg" width="100%" alt="dsh-files 架构：输入框、本地摄取、私有检索、模型工具以及原生视觉分支。">
</p>

## 从源码安装

需要：带 `web` profile 的 DeepSeek Harness CLI（已验证基线为 npm `@deepseek-ai/dsh@0.1.1-rc.2`）、Node.js `>=20.12.0`、`PATH` 中可用的 `pnpm`。

```sh
git clone https://github.com/Cooberped/dsh-files.git
cd dsh-files
pnpm install --frozen-lockfile
pnpm build

dsh plugin --profile web add .      # 把当前 checkout 链接到 web profile
dsh --profile web --dump-config     # 确认组合配置中已有该 bundle layer
dsh web                             # 重启
```

本地安装是对当前 checkout 的链接：拉取更新后重新执行 `pnpm install --frozen-lockfile && pnpm build` 并重启。卸载用 `dsh plugin --profile web remove @cooberped/dsh-files`。

<details>
<summary>未来的 npm Beta——目前尚不可用</summary>

只有在仓库发布 Gate 与 npm trusted publishing 全部闭合后，安装方式才会变成：

```sh
dsh plugin --profile web add @cooberped/dsh-files@beta
# 重启 dsh web
```

这里明确标成**未来命令**，现在执行不会成功。

profile/plugin 合同遵循官方 [Harness 插件参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)和 [bundle 发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

</details>

## 怎么用

1. 打开 Harness Web 输入框。
2. 添加文件：回形针多选、文件夹按钮选整个目录，或者直接把东西拖到页面上。
3. 确认每个预期文件都有独立卡片，并显示 `AI 可读取`。
4. 提一个具体问题——模型会自己调用工具。

好用的提示词：

```text
先索引这三个文件，不要立即总结。
```

```text
在这些材料中查找 Q3 留任指标的定义和公式。
每个判断都给出来源文件与准确页码、幻灯片、行区间或 Sheet!Range。
```

```text
比较会议决定与工作簿目标。
如果材料不足，请说明缺少什么，不要猜测。
```

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/evidence-loop.svg" width="100%" alt="推荐的模型证据循环：盘点、检索、展开，再根据通过版本校验的证据回答。">
</p>

## 两个工具

| | `search_documents` | `read_document` |
| --- | --- | --- |
| 用来 | 找答案**在哪** | 读某个位置**是什么** |
| 主要入参 | `file_paths`，可选短 `query` | `file_path` 加 `coordinate`/`version`，或 `offset`/`limit`，或 `sheet`/`cell_range`/`list_sheets` |
| 不带 `query` | 索引发生变化的内容并返回紧凑清单，适合"先把这几个文件读一下" | — |
| 返回 | 排序后的证据块，每条带 `path`、`format`、`text`、`coordinate` 和 `version` | 一个分页窗口，或精确展开的单个坐标 |

两条规则撑起整个循环：

- **坐标绑定版本**（源文件哈希 + 解析/切块 Schema）。只要给了 `coordinate`，`version` 就是必填，并在返回任何内容前校验。文件改过之后旧坐标会**明确报错**，而不是悄悄读到错行。
- **零召回不等于可以猜。** 工具会引导模型换词重试、在合理时顺序读取，或者明确报告文件中没有证据。

## 支持格式与诚实边界

| 输入 | 本地投影 | 稳定坐标 | 当前边界 |
| --- | --- | --- | --- |
| Text | UTF-8、UTF-16 BOM、高置信度无 BOM UTF-16、GB18030 | `line:S-E`，可附 `chars:S-E` | 其他编码和二进制文件会被拒绝 |
| PDF | 文本层提取，保留页边界 | `page:N`，可附页内行/字符范围 | 扫描件和纯图片页没有 OCR |
| DOCX | 正文、段落、表格、页眉、页脚、脚注、尾注 | `line:S-E`，可附 `chars:S-E` | 不做图片 OCR，也不是 Word 像素级渲染器 |
| XLSX | Sheet 清单、单元格值、范围、行列坐标 | 带引号规则的 `Sheet!A1:F40` | 不计算公式、不解释图表/形状、不执行宏 |
| PPTX | 按页序提取 DrawingML 文本与 speaker notes | `slide:N`，可附页内行/字符范围 | 不做幻灯片图片 OCR，不解析图表数据、SmartArt、动画和嵌入对象 |
| JPEG/PNG/WebP/GIF | Harness 原生图片附件 | Harness 附件身份 | 需要支持视觉的模型；不由 `read_document` 解析 |

格式一律由字节判定，**不看扩展名**——可执行文件改名成 `.pdf` 会被拒绝。长输出按行分页并受字符预算约束，任何截断都会显式标记。

<details>
<summary><b>能力细节</b>——输入框、检索、精确读取、视觉转交</summary>

**输入框与上传**

- 回形针多选文件、整文件夹选择，以及页面级拖放。
- Finder 多选会合并 `DataTransfer.items` 与 `DataTransfer.files`，混合批次不会悄悄只剩第一个可识别文件。
- 文档在 Harness 图片专用 drop handler 之前被接管；纯 JPEG/PNG/WebP/GIF 仍走原生图片链路。
- 有界并发上传（默认 `4`）；单个文件失败不会取消整批。
- 按字节嗅探真实格式的文件卡，展示 `上传中` / `AI 可读取` / `失败` 状态。
- `@` 候选同时包含上传文件**和**工作区文件，对模型只投影工作区相对路径，不暴露宿主机绝对路径。
- 每会话配额、SHA-256 去重、TTL 清理、安全文件名归一化、文件夹递归清理。

**本地检索**

- 中文连续段按重叠 bigram 建索引并以短语查询，因此 `流程绩效` 不会命中只含 `绩效流程` 的块。单汉字走有界子串回退；`Q3` 这类字母数字保持整词。
- 只有启动能力探针成功才启用 SQLite FTS5；否则明确选择 JS 内存后端，并在工具结果里说明。
- 默认不持久化模型检索词。

**精确文档读取**

- XLSX 支持工作簿结构盘点、1-based Sheet 选择、坐标保真的 A1 范围、合并表头、隐藏/稀疏 Sheet，以及明确的检测值计数。
- PPTX 按演示文稿关系声明的页序读取，而不是 ZIP 文件名顺序。
- system prompt 要求模型优先使用本插件工具；只有收到明确错误或"不支持能力"提示后，才可回退 Python/shell。

**原生视觉转交**

- JPEG/PNG/WebP/GIF 使用 Harness 原生输入框附件 rail 和供应商中立的 base64 `image_url` 路径。
- 所选模型仍必须声明支持图片输入；插件不会把纯文本模型变成视觉模型。

</details>

## 配置

bundle 在 [`cordis.patch.yml`](cordis.patch.yml) 中提供保守默认值。Harness 会在 bundle layer 之后应用用户 profile overlay，启动前先查看最终组合结果：

```sh
dsh --profile web --dump-config
```

| 配置项 | 默认值 | 含义 |
| --- | ---: | --- |
| `maxFileBytes` | 24 MiB | 单次文档读取字节上限 |
| `uploadMaxBytes` | 24 MiB | 单次上传请求体字节上限 |
| `maxUploadBytesPerSession` | 512 MiB | 会话上传配额；`0` 表示显式关闭 |
| `readLimit` | bundle patch 为 2,000；Schema 回退值 800 | 单次 `read_document` 返回的最大行数 |
| `maxOutputChars` | 24,000 | 基础字符窗口；叙述型格式使用更小的分格式窗口 |
| `maxConcurrentUploads` | 4 | 同时受理的上传请求体数量 |
| `uploadTtlMs` | 7 天 | 上传文件保留时长 |
| `retrievalEnabled` | `true` | 启用 `search_documents`；关闭后仍保留 `read_document` |
| `retrievalMaxFiles` / `retrievalMaxResults` | 12 / 12 | 单次检索文件数 / 返回证据块数 |
| `retrievalQueryLogEnabled` | `false` | 是否持久化归一化后的模型检索词 |
| `trustedHosts` | `[]` | 额外的反向代理 authority；为空表示仅回环 |

其余不常用配置项及其权威默认值见 [`src/index.ts`](src/index.ts)。显式配置的 `retrievalIndexDir` 必须是绝对私有路径，且不展开 `~`。

**运行时后端。** 包本身接受 Node.js `>=20.12.0`。持久检索索引还额外要求 Harness 实际 runtime 提供 Node.js `>=22.5.0`、`node:sqlite` 与 FTS5；Node 20 或任何探测失败都会使用功能完整但进程内的 JS 后端。工具输出会报告实际选中的后端——回退是受支持的模式，不是静默的部分成功。

## 安全与隐私

- **以字节为准。** 扩展名只是提示。PDF 头与 OOXML ZIP 成员决定解析器；已知异类二进制和伪装文件会被拒绝。
- **有界 OOXML。** 在解析器分配内存前限制 ZIP 成员数量与名称长度、声明 XML 大小、XML 总展开量、工作簿行列以及稀疏 Sheet 维度。
- **工作区包含性。** 读取走 `ctx.fs`；存在 session cwd 时，目标必须留在当前会话工作区内。
- **安全上传落盘。** 拒绝预先存在的符号链接与特殊文件；平台支持时使用 exclusive/no-follow 创建；配额与删除保持 fail closed。
- **默认仅回环。** 上传与工作区端点要求回环 Host 并做同源校验。`trustedHosts` 只用于部署方控制的反向代理。

> `trustedHosts` **不是身份认证。** 当前 Harness WebServer 插件合同不能证明某个 session ID 一定属于调用者。不要把本插件直接暴露成未经认证的公网多租户上传服务；应使用仅回环的自托管方式，或由同时约束 session 访问的认证代理承载。

<details>
<summary><b>数据存在哪里，什么会离开本机</b></summary>

| 存储 | 默认位置 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| 上传文件 | `<会话工作区>/.dsh-filess/<storageKey>/` | 上传的原始字节 | 每会话配额、SHA-256 去重、默认 7 天 TTL 清扫 |
| 检索索引 | `$DSH_HOME/dsh-files/index` | 检索投影、坐标、版本；只有显式开启时才存 query | 私有权限、文档/query TTL；无法持久化时回退 JS 内存 |

- 解析与索引都发生在 Harness 主机本地；插件自身不会调用任何外部解析服务。
- 但工具返回的证据**确实会**进入对话，并可能发送给你配置的模型供应商；原生图片附件同样会发送给所选视觉模型供应商。
- 不要把检索目录同步到云盘，也不要提交到 Git。

</details>

<details>
<summary><b>已知边界</b>——本项目刻意不做的事</summary>

- 扫描版 PDF 和 Office 文件中的内嵌图片不做 OCR。
- Office 版式被投影为文本与坐标，不做像素级还原。
- XLSX 公式不计算，宏永不执行。
- PPTX 图表、SmartArt、动画和嵌入对象不做解释。
- 上传配额锁是进程内的，不是跨进程事务。
- 纯 Node 没有完整可移植的 dirfd/openat 链，同 UID 恶意进程抢占祖先目录仍属于 OS 隔离边界。
- 兼容性刻意锁定在已验收的 Harness 预发布版本线，直到更新的 runtime 通过同一套验收流程。

</details>

## 项目状态

| | |
| --- | --- |
| 项目 | 公开源码 Beta，由 Cooberped 独立维护 |
| Harness 基线 | 已按 npm `@deepseek-ai/dsh@0.1.1-rc.2` 的 `web` profile 验证 |
| 真实环境验收目标模型 | OpenCode Go — DeepSeek V4 Flash |
| npm | **尚未发布。** 包元数据声明目标为 `@cooberped/dsh-files@0.6.0-beta.1`；scope 所有权、trusted publishing 与首次发布许可 Gate 尚未闭合 |
| 兼容性 | 未经单独验收，不宣称兼容更新的 Harness 源码版本线 |

本项目**不是 DeepSeek 官方插件**，与 DeepSeek 不存在隶属或官方背书关系。它也不是 clean-room 重写：仓库保留 MIT 许可的 [taxueseek/dsh-files](https://github.com/taxueseek/dsh-files) 历史；本文所述检索、坐标、安全、性能与发布治理层由 Cooberped 继续独立开发。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm benchmark:retrieval
pnpm license:check
pnpm package:check

pnpm release:check   # 以上全部，用于最终候选
```

`release:check` 覆盖类型检查、两个 bundle、聚焦回归测试、双后端检索正确性、许可策略与 npm tarball 合同。benchmark 使用确定性的合成 PDF/DOCX/XLSX/PPTX 素材——真实业务文档、答案集与模型输出一律留在仓库之外，详见 [`benchmark/README.md`](benchmark/README.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。所有贡献都由**维护者在必需检查通过后人工评审合并**，GitHub 不会自动合并社区代码。

提 PR 之前：阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 并为提交签署 DCO；为行为变更补充聚焦测试；在本地跑最小相关检查；不要把真实文档、凭据、私有路径和模型输出提交到 Git；每一项新增视觉素材都要登记到 [`assets/README.md`](assets/README.md)。

安全问题按 [`SECURITY.md`](SECURITY.md) 处理。发布归属与来源 Gate 见 [`RELEASING.md`](RELEASING.md)。

## 许可、传承与标识

项目代码与仓库原创 SVG 文档图形采用 [MIT License](LICENSE)。上游历史与版权声明完整保留。依赖与附带数据的许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

DeepSeek、DeepSeek Harness、OpenCode Go 及其他第三方名称或标识归各自权利人所有，此处仅用于说明兼容性或测试目标。素材来源登记见 [`assets/README.md`](assets/README.md)。
