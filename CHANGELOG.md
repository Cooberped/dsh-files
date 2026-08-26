# Changelog

## 0.6.0-local.3（本机检索层候选，未发布）

### 新增

- 新增 `search_documents`：首次按内容 sha256 建立版本化证据块，后续只返回与短查询相关的页码、行区间或 `Sheet!Range`；`read_document` 保留为坐标扩展器，不再要求模型反复扫描整份长文档。
- 中文连续段用有序 bigram 短语查询，`流程绩效` 不命中仅含 `绩效流程` 的干扰块；单汉字走选定文档内的有界子串回退；ASCII/数字词（`Q3`、`IPD`）保持整词。
- 启动时在 Harness **实际 Node runtime** 探测 `node:sqlite`、SQLite 版本、FTS5 compile option 与有序短语；失败自动回退进程内 JS 索引，不阻断插件启动。
- SQLite 索引位于 `$DSH_HOME/dsh-files/index`（目录 `0700`、数据库及 WAL/SHM `0600`），文档孤儿索引和私有查询日志均有 30 天 TTL。
- 仓库内新增 10 类纯合成检索正确性 benchmark；SQLite 与 JS 后端同时校验文档、坐标和事实，真实 HR benchmark 仍仅通过仓库外绝对路径引用。

### 边界

- 本版本不修改 `src/parse/*`，解析器替换与 block IR 重构留待检索 A/B 成立之后。
- 检索和索引只在工具调用阶段运行，不订阅模型流式 chunk，不向吐字链路增加逐 chunk 同步工作。
- 未执行外部模型 A/B，未把真实 HR 文件、答案或索引写入仓库。

## 0.5.0-local.5（本机真实环境候选，未发布）

### 修复

- Finder 多选拖放在事件生命周期内同步快照 `DataTransfer.items` 与 `DataTransfer.files`，保证 PDF、DOCX、XLSX 同批进入上传队列。
- 拖放去重键和服务端落盘名统一为 NFC，避免 Finder 的 NFD 文件名与浏览器 NFC 视图被当作两个文件。
- 文档拖拽不再切换全屏遮罩；纯图片拖拽继续交给 Harness 原生附件 UI，降低正常对话区域闪动风险。

### 边界

- 本提交只修改拖放收集、文件名规范化与客户端交互，不改任何文档解析器。
- 真实 HR 文件仅用于仓库外本机验收，不进入源码、fixture 或提交历史。

## 0.5.0-local.4（本机真实环境候选，未发布）

### 修复

- Finder 批量拖放在 `drop` 事件结束前同步快照 `DataTransfer.items` 与 `DataTransfer.files`，避免首次异步目录项读取后浏览器保护拖拽数据，导致同批仅首个文件生效。
- 新增短生命周期 `DataTransfer` 回归测试，模拟 Chromium 在事件返回后的数据失效；覆盖 PDF + DOCX + XLSX 三文件同批拖入。

### 边界

- 本版本先用于真实环境稳定性与性能对照，未发布 npm、未推送远端。

## 0.5.0-local.3（本地稳定候选，未发布）

### 新增

- **AI 原生 XLSX 投影**：`list_sheets` 返回 used range、有效行与非空单元格计数；`sheet + cell_range` 支持 A1 范围精准读取，输出保留 row/column 坐标，模型无需调用 Python。
- **轻量 DOCX 投影**：基于 `fflate + saxen` 自研只读段落、表格、修订、脚注/尾注和页眉/页脚投影；对未展开的 `altChunk` 显式提示，并对 XML 部件数量与解压体积设上限。
- **上传状态轨道**：文档卡片展示 `上传中 / AI 可读取 / 失败`，含真实格式、大小、大文件与去重提示；文件名作为 Harness occurrence label，不再生成空白 chip。
- **官方 `@file` 语法**：对话只传工作区相对路径，空格路径自动加引号；不可表示的控制字符/双引号 fail-closed。

### 修复

- 升级并固定 `read-excel-file@9.3.10`，修复合法工作簿缺少 `xl/worksheets/sheet1.xml` 时旧版只读到表头的问题。
- 移除最新 Mammoth 仍携带的 `argparse@1.0.3 → lodash@3.2.0` 漏洞链；真实 21K 字会议纪要提取字符量保持约 99.5%，本机解析从约 48ms 降至约 17ms，生产依赖审计归零。
- 文件夹上传不再把文件名误建成目录；TTL 清扫覆盖实际会话工作区并递归回收子目录，同时用 `lstat` 避免跟随符号链接逃逸。
- 会话存储配额递归统计文件夹上传中的普通文件，并跳过符号链接，不再把目录 inode 大小误算为内容。
- 文档/目录拖放改在 capture 阶段先于 Harness 图片处理器接管，避免 PDF/DOCX/XLSX 批次误弹“仅支持图片”；纯 PNG/JPEG/WebP/GIF 仍完整交给官方原生附件链路。
- Finder 多选拖放同时合并 `DataTransfer.items` 与 `DataTransfer.files`，修复部分浏览器只暴露不完整 items 时丢文件；移除插件全屏拖放伪元素，避免对话窗口拖动期间闪烁。
- 删除上传文件时携带 `x-session-id`，并按 occurrence 精确长度移除含空格文件名；不再删除半截引用或被会话隔离静默拒绝。
- 所有截断、遗漏 sheet 与检测计数显式报告，不再把部分解析描述为“全量”。

### 边界

- 当前 Harness file-reference seam 仍将文件引用序列化为普通提示词；输入区可以呈现文档卡片，但已发送消息中的原生附件对象需要上游核心提供新合同。
- 此版本仅用于本机自用稳定性验证，未发布 npm、未推送远端。

## 0.4.0

### 新增

- **图片原生支持**：上传的 JPEG / PNG / WebP / GIF 不再落成本地路径让 `read_document` 读不了，而是走 harness 核心附件管线（`createDraftImages` → `addImages` → 发送时转 base64 `image_url`）。因为线格式是供应商中立的 base64，任何声明 `inputModalities: [text, image]` 的模型（DeepSeek 视觉版、Dots3、龙猫、OpenRouter 视觉模型等）都能直接看图；UI 由官方 `conversation.input.attachments` rail 渲染（缩略图、点开大图、原生移除），呈现为原生图片而非灰色 badge 卡片。
- **`@` 双源候选**：输入 `@` 同时列出本会话已上传文件（绝对路径）与会话工作区文件（相对路径，agent 按其 cwd 解析），无需重新上传即可引用已有工作区文件。
- **工作区索引端点**：`GET /api/workspace-files?session=<id>` 只读返回会话 cwd 下的相对路径列表；BFS 遍历带忽略目录/文件/扩展名过滤、深度（默认 12）与数量（默认 500）上限、跳过符号链接（防环与索引逃逸），与上传端点同款网络护栏。

### 修复

- **解析缓存 in-flight 去重**：`getOrCompute` 让并发同 key 的调用共享一次解析 promise，多个 agent 同时分页同一大 PDF 时只解析一次，不再重复解析。
- **`read_document` output schema 补 `sheet` 字段**：XLSX sheet 读取返回的合法输出此前会被 `additionalProperties:false` 打成 `INVALID_TOOL_OUTPUT`，现 schema 声明该字段。
- **文件夹上传保留子目录层级**：`x-file-relative-path` 的目录前缀在会话上传目录内重建（如 `sub/dir/file.pdf`），相对路径净化（拒绝 `../` 与绝对路径），sha256 去重竞态有回退写入保护。

### 其他

- 上传端点与工作区索引端点共用 `trustedHosts` 语义，公网域名 / 反向隧道部署不再静默 403。
- 新增 workspace 回归测试（索引、忽略规则、symlink 跳过、maxDepth/maxFiles 上限）与图片原生路径的 client 侧分流测试；tsc 零错。

## 0.3.0

### 修复

- **read_document 不再拒绝 >64 KiB 文件**（#5）：此前用 64 KiB 上限做头部嗅探预读，而底层 `readBytes` 的 `maxBytes` 是整文件上限（超限直接抛 `FS_TOO_LARGE`），任何大文件都会在嗅探阶段被误拒。现改为一次读满 `maxFileBytes`，格式从缓冲前 64 KiB 截取判定。模型读取大 PDF/DOCX/XLSX 恢复正常。
- **公网域名 / 反向隧道部署下上传不再静默 403**（#6）：上传栅栏此前硬编码 loopback-only 且 Origin 比较完整 URL（含 scheme），`dsh web --trusted-host` 部署的 GUI 上传全部被拒且界面无提示。现支持 `trustedHosts` 配置（裸 host 匹配任意端口、`host:port` 精确匹配，与官方 `--trusted-host` 栅栏同语义，启动时校验条目），Origin 只比较 host 部分兼容上游终结 TLS；客户端 403 错误改为明确提示，不再被空 catch 吞掉。

### 新增

- **文件夹上传**（#1）：输入框工具栏新增文件夹按钮（`webkitdirectory` 目录选择），页面任意位置拖拽也支持文件夹（目录项递归展平，保留子目录文件）。
- **有界并发上传**：批量上传固定 4 路并发（与服务端 `maxConcurrentUploads` 默认值对齐），文件夹 / 多文件上传不再串行排队，也不触发 429；逐文件失败只记入错误提示，不阻塞其余文件。
- 回形针按钮保持文件多选能力不变（与文件夹按钮分离）。

### 其他

- 新增 guard 回归测试 12 项、read_document 64 KiB 回归测试 2 项，测试总数 78 项全过，tsc 零错。

## 0.2.0

- **@ 文件候选**：输入框输入 `@` 列出本会话已上传文件，选中插入路径引用，模型据此 `read_document`。
- **差异化输出预算**：单次输出窗口按格式分级（text 满额、xlsx 3/4、pdf/docx 1/2），超限截断并显式标记，降低上下文 token 占用。
- **解析缓存键改内容 sha256**：文件内容变化必然失效（不再仅依赖文件版本）。
- **readTimeoutMs 可配置**：`read_document` 单次执行超时（默认 120s），大 PDF 解析不再依赖硬编码。
- **UTF-16 无 BOM 识别**：编码链（UTF-16 BOM → UTF-8 → GB18030 → UTF-16 无 BOM）补全，中文 GBK 与无 BOM UTF-16 文件均可读。
- **上传增强**：readHint 体量提示（cost / estimatedChars）、emoji 文件名按码点截断（不切出孤立代理）、sha256 内容去重竞态修复、413 提前拒绝并排空请求体（keep-alive 不挂起）。
- **网络栅栏与配额**：loopback + same-origin + sec-fetch-site 三重校验；会话存储配额（超限 507）；未知会话 403；并发限流（默认 4）超限 429。
- **XLSX sheet 级读取**：`sheet` 参数返回指定工作表全量，`list_sheets` 先列全部 sheet 名，越界报错附可用列表。
- **整页拖拽上传**：页面任意位置拖拽文件上传，悬停遮罩提示。
- **文件名净化**：按 UTF-8 字节截断并保留扩展名，长中文名不触发 ENAMETOOLONG。

## 0.1.0

- 首版：Web UI 回形针上传 + 模型读文档（text / PDF / DOCX / XLSX）。
- 内容嗅探 + LRU 缓存。
