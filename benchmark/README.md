# dsh-files document benchmark

这个目录只保存**合成资料**与公开的验收契约，不保存真实业务文档、真实答案或模型输出。

## 两层数据

1. `cases.synthetic.json` + `fixtures/generated/`
   - 可提交、可复现、无真实人员或业务数据。
   - 覆盖 PDF 页码、DOCX 段落/表格、XLSX 合并表头、隐藏 Sheet、稀疏 `Z200`、NFD 文件名、中文短语顺序、单汉字和 `Q3`/`IPD` 中英数字混排。
2. 仓库外真实 benchmark
   - manifest、三个真实文件和确定答案必须全部位于仓库外。
   - 通过 `DSH_FILES_REAL_BENCHMARK_MANIFEST=/absolute/path/manifest.json` 引用。
   - `benchmark:validate-real` 会 fail closed：manifest 或任一文档落在仓库内就拒绝。

## 命令

```bash
pnpm benchmark:fixtures
pnpm benchmark:validate
DSH_FILES_REAL_BENCHMARK_MANIFEST=/absolute/outside/repo/manifest.json pnpm benchmark:validate-real
```

fixture 生成器采用固定时间、固定文件顺序与固定压缩参数。`benchmark/fixtures/generated/` 不进入 npm 包的 `files` 白名单，因此不会增加插件安装体积。

Git 中的三个二进制采用可移植的 NFC 文件名。生成器运行时会额外创建一个 NFD DOCX alias；这样不会依赖 macOS Git 的 `core.precomposeunicode` 行为，但真实文件选择与去重仍能覆盖 NFD 边界。

## A/B 评分合同

每个 case 同时记录：

- `expected.facts`：答案必须覆盖的确定事实；
- `expected.evidence`：应命中的文档与稳定坐标；
- `forbiddenFacts`：常见干扰项或不可凭空生成的事实；
- `noAnswer`：资料没有答案时必须明确拒答；
- `queryClass`：精确坐标、跨 Sheet、跨文件、短语顺序、单字、混排或负例。

模型 A/B 还需在仓库外记录实际 query、召回 block、工具调用次数、Python/Bash 回退、TTFT、总耗时和 token usage。答案正确率与证据覆盖率是硬指标，不能用“少调用工具”替代。
