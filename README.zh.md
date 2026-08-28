<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/hero.svg" width="100%" alt="dsh-files 将本地文件经过上传、检索和带版本坐标回读，转化为可追溯证据，并保留原生视觉链路。">
</p>

# dsh-files

**一个小而完整的独立社区插件，为 DeepSeek Harness 补齐“文件 → 证据”的工作闭环。**

在 Web 输入框一次上传多个文件或整个文件夹；解析与检索留在本机；模型先搜索紧凑证据，再按需展开准确的页码、幻灯片、行区间或表格范围；栅格图片继续使用 Harness 原生视觉链路。

> [!IMPORTANT]
> **当前是源码 Beta，尚未发布 npm。** 仓库已经可以从源码本地安装，但 npm 上目前不存在 `@cooberped/dsh-files@beta`。请使用下方[源码安装](#从源码安装)；不要把“未来 npm 命令”误认为现在已经可用。

| 状态 | 当前结论 |
| --- | --- |
| 项目 | 公开源码 Beta，由 Cooberped 独立维护 |
| Harness 基线 | 已按 npm `@deepseek-ai/dsh@0.1.1-rc.2` 的 `web` profile 验证 |
| 真实环境验收目标模型 | OpenCode Go — DeepSeek V4 Flash |
| npm | **尚未发布**；包元数据声明目标为 `@cooberped/dsh-files@0.6.0-beta.1`；scope 所有权、trusted publishing 与首次发布许可 Gate 尚未闭合 |
| 兼容性 | 未经单独验收，不宣称兼容更新的 Harness 源码版本线 |

本项目**不是 DeepSeek 官方插件**，与 DeepSeek 不存在隶属或官方背书关系。它也不是 clean-room 重写：仓库保留 MIT 许可的 [taxueseek/dsh-files](https://github.com/taxueseek/dsh-files) 历史；本文所述检索、坐标、安全、性能与发布治理层由 Cooberped 继续独立开发。

## 为什么要做这个插件

只有文件选择器，并不等于智能体真正擅长文档。如果把每份文件全文塞入 prompt，长表格和会议记录会在模型知道“什么重要”之前就消耗上下文；如果只给模型一个本地路径，它又往往回退到 Python 或 shell，重复做高成本遍历。

`dsh-files` 采用更小的循环：

1. **只上传一次**，文件落在当前会话工作区。
2. **在本地建立索引**，不把全文预先塞进模型上下文。
3. **围绕具体问题检索紧凑证据**。
4. **只在需要时展开带版本的准确坐标**。
5. **基于证据回答**；没有证据就明确说明。

这是本项目最核心的设计贡献：文件不再只是 prompt 负担，而成为可寻址、可回读的证据。

## 这个项目增加了什么

| 设计选择 | 带来的改变 |
| --- | --- |
| **一个双面 bundle** | 同一个 Harness bundle 同时挂载 Web 输入面和 Host 侧模型工具。 |
| **证据优先工具循环** | `search_documents` 负责盘点/检索，`read_document` 负责展开准确证据，不再反复扫完整文件。 |
| **可逆、带版本坐标** | 证据可指向 PDF 页、PPTX 幻灯片、text/DOCX 行区间或带引号规则的 XLSX `Sheet!Range`；内容/Schema 版本过期就 fail closed。 |
| **保持顺序的中文检索** | 中文连续段使用重叠 bigram 与短语匹配；单汉字使用有界子串回退；`Q3` 等字母数字保持整词。 |
| **适配实际 runtime 的索引** | 启动时探测 Harness 实际 runtime 的 `node:sqlite` 与 FTS5；不满足条件时回退到合同一致、零额外依赖的 JS 内存后端。 |
| **防御式本地摄取** | 从字节判断真实格式；限制 OOXML 展开量和工作表逻辑网格；路径留在会话工作区；任何截断都显式呈现。 |
| **很小的包自有表面积** | 发布 Gate 要求包自有 npm 解包体积小于 1 MiB，并排除 benchmark、源码、测试、截图与 vendored 依赖；安装后的第三方依赖体积另算。 |

<p align="center">
  <img src="https://raw.githubusercontent.com/Cooberped/dsh-files/main/assets/readme/architecture.svg" width="100%" alt="dsh-files 架构：输入框、本地摄取、私有检索、模型工具以及原生视觉分支。">
</p>

## 能力

### 输入框与上传

- 回形针**多选文件**、整文件夹选择，以及页面级拖放。
- Finder 多选会合并 `DataTransfer.items` 与 `DataTransfer.files`，混合文档批次不会悄悄只剩第一个可识别文件。
- 文档在 Harness 图片专用 drop handler 之前被插件接管；纯 JPEG/PNG/WebP/GIF 仍走原生图片链路。
- 有界并发上传（默认 `4`）；单个文件失败不会取消整批文件。
- 按字节嗅探真实格式的紧凑文件卡，展示 `上传中`、`AI 可读取`、`失败` 状态。
- `@` 候选同时包含上传文件和工作区文件；对模型只投影工作区相对路径，不暴露宿主机绝对路径。
- 每会话存储配额、SHA-256 去重、TTL 清理、安全文件名归一化和文件夹递归清理。

### 本地检索

- 不带 `query` 调用 `search_documents(file_paths)`：建立/更新私有索引，只返回紧凑文件清单。
- 带短 `query` 调用：返回按相关度排序的证据块，以及 `format`、`coordinate` 和 `version`。
- 只有启动能力探针成功才启用 SQLite FTS5；否则明确选择 JS 内存后端。
- 默认不持久化模型检索词。
- 内容版本包含源文件哈希与解析/切块 Schema 身份；内容或投影变化会使旧证据失效。

### 精确文档读取

- `read_document` 从内容判断真实格式，无需 Python 即可读取 text、PDF、DOCX、XLSX、PPTX。
- 长输出按行分页并受字符预算约束；任何截断都会显式标记。
- XLSX 支持工作簿结构盘点、1-based Sheet 选择、坐标保真的 A1 范围、合并表头、隐藏/稀疏 Sheet，以及明确的检测值计数。
- PPTX 按演示文稿关系声明的页序读取，并提取 DrawingML 文本和 speaker notes。
- 检索返回的坐标可连同同一版本回传给 `read_document`，做准确展开。
- system prompt 要求模型优先使用本插件工具；只有收到明确错误或“不支持能力”提示后，才可回退 Python/shell。

### 原生视觉转交

- JPEG、PNG、WebP、GIF 使用 Harness 原生输入框图片附件 rail。
- 图片通过供应商中立的 base64 `image_url` 路径序列化。
- 所选模型仍必须声明支持图片输入；插件不会把纯文本模型变成视觉模型。

## 支持格式与诚实边界

| 输入 | 本地投影 | 稳定坐标 | 当前边界 |
| --- | --- | --- | --- |
| Text | UTF-8、UTF-16 BOM、高置信度无 BOM UTF-16、GB18030 | `line:S-E`，可附 `chars:S-E` | 其他编码和二进制文件会被拒绝 |
| PDF | 文本层提取，保留页边界 | `page:N`，可附页内行/字符范围 | 扫描件和纯图片页没有 OCR |
| DOCX | 正文、段落、表格、页眉、页脚、脚注、尾注 | `line:S-E`，可附 `chars:S-E` | 不做图片 OCR，也不是 Word 像素级渲染器 |
| XLSX | Sheet 清单、单元格值、范围、行列坐标 | 带引号规则的 `Sheet!A1:F40` | 不计算公式、不解释图表/形状、不执行宏 |
| PPTX | 按页序提取 DrawingML 文本与 speaker notes | `slide:N`，可附页内行/字符范围 | 不做幻灯片图片 OCR，不解析图表数据、SmartArt、动画和嵌入对象 |
| JPEG/PNG/WebP/GIF | Harness 原生图片附件 | Harness 附件身份 | 需要支持视觉的模型；不由 `read_document` 解析 |

## 从源码安装

要求：

- DeepSeek Harness CLI 与 `web` profile；已验证基线为 npm `@deepseek-ai/dsh@0.1.1-rc.2`。
- Node.js `>=20.12.0`。
- `PATH` 中可用的 `pnpm`。

```sh
git clone https://github.com/Cooberped/dsh-files.git
cd dsh-files
pnpm install --frozen-lockfile
pnpm build

# Harness 官方 profile 插件形式：把当前 checkout 链接到 web profile。
dsh plugin --profile web add .

# 确认组合配置中已有 @cooberped/dsh-files bundle layer。
dsh --profile web --dump-config

# 安装或重新构建后重启。
dsh web
```

本地安装会链接当前 checkout。切换分支或拉取更新后，重新运行 `pnpm install --frozen-lockfile`、`pnpm build`，再重启 `dsh web`。

卸载：

```sh
dsh plugin --profile web remove @cooberped/dsh-files
```

profile/plugin 合同遵循官方 [DeepSeek Harness 插件参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)和[bundle 发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

### 未来 npm Beta

只有在仓库发布 Gate、npm trusted publishing 等条件全部闭合后，才会使用：

```sh
dsh plugin --profile web add @cooberped/dsh-files@beta
# 重启 dsh web
```

这里明确把它标成**未来命令**，不代表当前已经可以从 npm 安装。

## 如何使用

1. 打开 Harness Web 输入框。
2. 用回形针选择多个文件、选择一个文件夹，或直接把文件拖到页面。
3. 确认每个预期文件都有独立卡片，并显示 `AI 可读取`。
4. 提出具体问题，模型应自动调用工具。

推荐提示词：

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

## 模型工具合同

### `search_documents`

所有附件文档任务都应先用这个工具。

| 输入 | 用途 |
| --- | --- |
| `file_paths` | 一个或多个相关 PDF/DOCX/XLSX/PPTX/text 路径 |
| 不带 `query` | 索引发生变化的内容，返回紧凑清单 |
| `query` | 针对短关键词或准确短语返回排序证据块 |

每条证据都包含可控回读所需的信息：

- 投影后的工作区相对 `path`；
- 检测出的 `format`；
- 证据 `text`；
- 稳定 `coordinate`；
- 与解析/切块 Schema 绑定的 `version`；
- 不泄漏本机诊断路径的后端/状态提示。

零召回不等于可以猜。工具会引导模型换词重试、在合理时顺序读取，或明确报告文件中没有证据。

### `read_document`

用于展开已选中的检索结果，或执行有意的兼容分页读取。

| 输入 | 用途 |
| --- | --- |
| `file_path` | 按当前会话解析的文档路径 |
| `coordinate` + `version` | 精确展开 `search_documents` 返回的证据 |
| `offset` + `limit` | 受控顺序分页 |
| `list_sheets` | 不返回单元格值的 XLSX 结构盘点 |
| `sheet` + 可选 `cell_range` | 一个工作表或 A1 范围 |

只要提供 `coordinate`，`version` 就必须同时提供，并会在返回文档内容前校验。文件或投影合同变化后必须重新检索。

## 存储与隐私

本插件有两个用途不同的本地存储：

| 存储 | 默认位置 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| 上传文件 | `<会话工作区>/.dsh-filess/<storageKey>/` | 上传的原始字节 | 每会话配额、SHA-256 去重、默认 7 天 TTL 清扫 |
| 检索索引 | `$DSH_HOME/dsh-files/index` | 检索投影、坐标、版本；只有显式开启时才存 query | 私有权限、文档/query TTL；无法持久化时回退 JS 内存 |

必须理解的隐私边界：

- 解析与索引发生在 Harness 主机本地。
- 工具返回给模型的选定证据会进入对话，并可能发送给配置的模型供应商。
- 原生图片附件也会发送给所选视觉模型供应商。
- 插件自身不会调用外部文档解析服务。
- 不要把检索目录同步到云盘，也不要提交到 Git。

## 安全模型

- **以字节为准：**扩展名只是提示。PDF 头与 OOXML ZIP 成员决定解析器；已知异类二进制和伪装文件会被拒绝。
- **有界 OOXML：**在解析器分配内存前限制 ZIP 成员数量/名称、声明 XML 大小、XML 总展开量、工作簿行列与稀疏 Sheet 维度。
- **工作区包含性：**读取走 `ctx.fs`；存在 session cwd 时，目标必须留在当前会话工作区。
- **安全上传落盘：**拒绝预先存在的符号链接/特殊文件；平台支持时使用 exclusive/no-follow 创建；配额与删除保持 fail closed。
- **默认网络边界：**上传/工作区端点默认信任回环与同源检查；`trustedHosts` 只用于部署方控制的反向代理。

`trustedHosts` **不是身份认证**。当前 Harness WebServer 插件合同不能证明某个 session ID 一定属于调用者。不要把本插件直接暴露成未经认证的公网多租户上传服务；应使用仅回环的自托管方式，或由同时约束 session 访问的认证代理承载。

## 配置

bundle 在 [`cordis.patch.yml`](cordis.patch.yml) 中提供保守默认值。Harness 会在 bundle layer 之后应用用户 profile overlay；启动前先查看最终组合结果：

```sh
dsh --profile web --dump-config
```

常用设置：

| 设置 | 默认值 | 含义 |
| --- | ---: | --- |
| `maxFileBytes` | 24 MiB | 单次文档读取字节上限 |
| `uploadMaxBytes` | 24 MiB | 单个上传正文上限 |
| `maxUploadBytesPerSession` | 512 MiB | 会话上传配额；`0` 表示显式关闭配额 |
| `readLimit` | bundle patch 为 2,000；Schema 回退值 800 | 单次 `read_document` 返回行数上限 |
| `maxOutputChars` | 24,000 | 基础字符窗口；叙事类格式使用更小的格式化窗口 |
| `maxConcurrentUploads` | 4 | 允许同时接收的上传正文数 |
| `uploadTtlMs` | 7 天 | 上传文件保留期 |
| `retrievalEnabled` | `true` | 启用 `search_documents`；关闭后 `read_document` 仍可用 |
| `retrievalMaxFiles` | 12 | 单次检索文件数 |
| `retrievalMaxResults` | 12 | 返回证据块数 |
| `retrievalQueryLogEnabled` | `false` | 是否持久化归一化模型检索词用于本地调优 |
| `trustedHosts` | `[]` | 额外反代 authority；空数组表示只允许回环 |

低频设置及权威默认值见 [`src/index.ts`](src/index.ts)。显式配置 `retrievalIndexDir` 时必须使用绝对私有路径；不会展开 `~`。

### runtime 后端选择

本包接受 Node.js `>=20.12.0`。

- 持久检索索引要求 Harness 实际 runtime 同时具备 Node.js `>=22.5.0`、`node:sqlite` 与 FTS5。
- Node 20 或任何能力探测失败，都会使用功能完整但只存在于当前进程的 JS 后端。
- 工具输出会报告实际后端；回退是受支持模式，不是静默的部分成功。

## 已知限制

- 扫描版 PDF 与 Office 文件内嵌图片不做 OCR。
- Office 布局会投影为文本/坐标，但不是像素级渲染。
- XLSX 不计算公式，永不执行宏。
- PPTX 不解释图表、SmartArt、动画与嵌入对象。
- 上传配额锁是进程内锁，不是跨进程事务。
- 可移植 Node 没有完整 dirfd/openat 链；恶意同 UID 进程抢占祖先目录仍属于 OS 隔离边界。
- 兼容性会保持在已验证的 Harness 预发布版本线；新 runtime 必须通过相同验收后才会扩展声明。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm benchmark:retrieval
pnpm license:check
pnpm package:check

# 只对稳定最终候选运行：
pnpm release:check
```

仓库 benchmark 使用确定性生成的合成 PDF/DOCX/XLSX/PPTX fixture。真实业务文档、答案集与模型输出必须留在仓库外；详见 [`benchmark/README.md`](benchmark/README.md)。

`release:check` 覆盖类型检查、两侧 bundle、聚焦回归测试、双后端检索正确性、许可策略和 npm tarball 合同。

## 参与共建

欢迎 Issue 和 Pull Request。社区代码会在必需检查通过后由维护者**审查并合并**；GitHub 不会自动把外部提交合入主分支。

提交 PR 前：

1. 阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并按 DCO 为 commit 签署 `Signed-off-by`。
2. 行为变更必须增加聚焦测试。
3. 本地只运行与当前修改相关的最小检查。
4. 不得把真实文档、凭据、私有路径和模型输出放进 Git。
5. 新增视觉素材必须同步登记到 [`assets/README.md`](assets/README.md)。

安全问题按 [`SECURITY.md`](SECURITY.md) 报告；发布所有权与 provenance Gate 见 [`RELEASING.md`](RELEASING.md)。

## 许可、沿革与商标

项目代码与仓库原创 SVG 文档图采用 [MIT License](LICENSE)。上游历史与版权声明继续保留。依赖和 bundled-data 说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

DeepSeek、DeepSeek Harness、OpenCode Go 及其他第三方名称/标识归各自权利人所有；这里只用于说明兼容对象或测试目标。素材来源见 [`assets/README.md`](assets/README.md)。
