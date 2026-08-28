# Changelog

## 0.6.0-local.9（工作区路径重投影，未发布）

### 修复

- Harness 会在模型上下文中把 `@` 文件引用展开为绝对路径，因此仅保留工具调用入参仍可能泄露 `/Users/...`。现对位于当前 session cwd 内的绝对输入做 containment 检查并重投影为 POSIX 工作区相对路径；workspace 外由用户显式提供的绝对路径保持不变。
- 回归测试改用绝对工作区输入，断言 `documents[]` 与搜索命中仅返回相对路径。本候选沿用 `0.6.0-local.8` 的计数语义修复及此前全部加固。

## 0.6.0-local.8（工具计数语义修复，未发布）

### 修复

- 真实模型在缓存命中后把 `indexedDocuments: 0` 误解成“没有文档”，重复调用检索。现新增必填 `documentCount` 表示已就绪的总文档数，并在 schema 中明确 `indexedDocuments` 只表示“本次新建索引数”，缓存命中为 0 是正常行为。
- 本候选沿用 `0.6.0-local.7` 的相对路径隐私修复、`0.6.0-local.6` 的输出 schema 修复及此前全部加固；版本继续独立递增。

## 0.6.0-local.7（模型侧路径隐私修复，未发布）

### 修复

- 真实工具轨迹确认索引已可用后，进一步发现检索结果使用了 `target.displayPath`，会把本机绝对 `/Users/...` 路径回传给模型。现持久索引与工具结果保留调用时的工作区相对路径；绝对路径只留在本机 fs observation / 错误诊断中。
- 本候选沿用 `0.6.0-local.6` 的真实 Harness schema 修复及 `0.6.0-local.5` 的全部加固，并再次递增制品版本以保持安装证据可追溯。

## 0.6.0-local.6（真实 Harness 合同修复，未发布）

### 修复

- 真实 Harness 调用发现 `search_documents.documents[]` 泄露了 schema 未声明的内部 `id`，导致工具输出被 `additionalProperties: false` 拒绝；现仅投影 `path / format / version`，并补精确键集合回归测试。
- 本候选沿用 `0.6.0-local.5` 的全部安全、坐标、检索与性能加固；版本单独递增，避免把真实环境失败包与修复包标成同一制品。

## 0.6.0-local.5（本机加固候选，未发布）

### 修复

- XLSX 在解压前解析有界中央目录元数据，拒绝 ZIP64、4 GiB 等伪造展开声明、过量 XML/成员及超长成员名；改用与预检声明一致的 universal/fflate 解压路径，封闭可导致 Harness OOM 的无界分配。
- XLSX 索引改为一次解析 workbook、内存投影全部 Sheet；真实 605 KiB / 9 Sheet 本机探针由约 158.2 ms、+28.8 MiB RSS 降至约 48.3 ms、+10.9 MiB RSS。
- `search_documents → read_document` 坐标合同闭环：PDF page、PPTX slide、DOCX/text line 及带引号 XLSX `Sheet!Range` 均可携版本精确展开；检索版本绑定解析/切块 schema，旧索引自动失效。
- PDF 页面使用 form-feed 内部边界，不再靠正文中的空行猜分页；合法自定义 PPTX slide relationship target 可读取。
- 达到文档块上限时缓存显式截断标记而不是反复失败；零召回会要求换词、按坐标分页且禁止无证据猜答。
- SQLite 和 JS 索引均分批构建并让出事件循环，完整投影就绪前不可见；20,000 块本机 SQLite 探针约 140 ms，期间 21 次 timer 轮转，最大间隔约 10.7 ms。
- 中文/中英混合检索补齐单字 SQL 前置过滤、NFKC 双后端一致性及长 CJK 短语有界 relaxed 回退。
- 上传 storage key 不再发生 `a/b` 与 `a:b` 折叠碰撞；raw session id 只做有界有效性检查并原样交给 Harness resolver。默认每会话 512 MiB 配额，同会话配额检查和落盘串行；扩展名/目录深度前置校验，digest 提升至 64 bit。
- 回环信任覆盖 127/8 与 IPv4-mapped 127/8，并验证真实 socket peer，阻断远端伪造 loopback Host；Origin authority 包含端口。
- 查询词持久化改为 `retrievalQueryLogEnabled: false` 隐私优先默认关闭；JS fallback 在工具输出中明确标为非持久并给出原因。

### 边界

- 官方 Harness WebServer 当前未向插件路由暴露认证身份或 session owner；`trustedHosts`、高熵 session id、目录 HMAC 都不能替代授权。远程部署必须由认证反向代理或未来 Harness 身份合同绑定 session。
- 解析器内部仍含同步 CPU 段；分块循环和索引写入已协作让出，但极端大文档的强取消/硬 CPU 隔离仍需 `worker_threads`。
- PPTX 图表缓存、SmartArt、图片 OCR/嵌入对象，以及 DOCX 任意命名 header/footer relationship 尚未纳入本候选；OCR 应保持独立可选插件。
- 真实 HR 文件只作仓库外本机只读性能/坐标探针，未写入 fixture、索引样本或提交历史；未发布 npm、未推送远端。

## 0.6.0-local.4（本机索引/PPTX 候选，未发布）

### 新增

- `search_documents` 支持省略 `query` 的索引模式：面向“先理解/准备这些文件，稍后再讨论”任务，只在本地建立版本化索引并返回紧凑文件清单，不把文档正文注入模型上下文；具体问题仍走原有短查询检索。
- 原生读取与检索 PPTX：复用既有 `fflate + saxen`，按 `presentation.xml.rels` 的真实演示顺序提取 slide text 与 speaker notes，检索坐标为 `slide:N`，不再启动 Python 子进程。
- 上传卡片按字节嗅探识别 PPTX 并显示 PowerPoint 徽标；系统提示将 PPTX 纳入受支持格式，显式禁止无错误时回退 shell/Python。
- 纯合成 benchmark 扩展为 PDF/DOCX/XLSX/PPTX 4 份文档、11 个确定答案用例；SQLite FTS5 与 JS fallback 同时校验 `slide:N` 证据。

### 边界

- PPTX 当前提取文本框、表格等 DrawingML 文本及 speaker notes；图片内文字、图表数据、SmartArt 和嵌入对象尚未展开。
- 无 query 索引模式不声称模型已把全文装入上下文；它为后续问题准备私有索引，具体回答仍按用户问题检索证据。
- 真实 HR 文件仅用于仓库外本机只读探针，未写入 fixture、源码或提交历史；本版本未发布 npm、未推送远端。

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
