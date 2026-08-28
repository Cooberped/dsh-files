// Every string that appears in the README diagrams, per locale.
//
// This is the file to edit when a capability changes. Geometry lives in the
// three renderer modules and is written once for both locales; widths that
// depend on the text are computed at build time, and fixed-grid slots are
// checked against their container so an over-long string fails the build
// instead of shipping clipped.

export const LOCALES = ['en', 'zh']

/** Output basename per locale: `hero` -> hero.svg / hero.zh.svg. */
export function fileName(base, locale) {
  return locale === 'en' ? `${base}.svg` : `${base}.${locale}.svg`
}

export const content = {
  hero: {
    en: {
      title: 'dsh-files',
      desc: 'A community DeepSeek Harness plugin that turns local files into versioned evidence through upload, local retrieval, coordinate reads, and native vision handoff.',
      badge: 'COMMUNITY PLUGIN · SOURCE BETA',
      wordmark: 'dsh-files',
      headline: 'Files become evidence, on demand.',
      tagline: 'Upload locally · retrieve precisely · expand by coordinate · keep images native',
      pills: ['Multi-file upload', 'Local retrieval', 'Versioned reads', 'Native vision'],
      pipeline: 'LOCAL EVIDENCE PIPELINE',
      files: [
        { kind: 'PDF', name: 'report.pdf' },
        { kind: 'DOCX', name: 'notes.docx' },
        { kind: 'XLSX', name: 'metrics.xlsx' }
      ],
      searchBadge: 'SEARCH',
      query: '“process efficiency”',
      backend: 'FTS5 / JS',
      evidenceBadge: 'EVIDENCE',
      evidence: 'Sheet “People”!B12:F18 · v:8f3…'
    },
    zh: {
      title: 'dsh-files',
      desc: '一个社区维护的 DeepSeek Harness 插件，通过上传、本地检索、坐标回读与原生视觉转交，把本地文件变成带版本的证据。',
      badge: '社区插件 · 源码 BETA',
      wordmark: 'dsh-files',
      headline: '让文件随时变成可引用的证据',
      tagline: '本地上传 · 精准检索 · 按坐标展开 · 图片原生直通',
      pills: ['多文件上传', '本地检索', '带版本读取', '原生视觉'],
      pipeline: '本地证据流水线',
      files: [
        { kind: 'PDF', name: '汇报.pdf' },
        { kind: 'DOCX', name: '纪要.docx' },
        { kind: 'XLSX', name: '指标.xlsx' }
      ],
      searchBadge: '检索',
      // The repository's own order-correct-CJK benchmark case, not a placeholder:
      // 流程绩效 must not match a block containing only 绩效流程.
      query: '“流程绩效”',
      backend: 'FTS5 / JS',
      evidenceBadge: '证据',
      evidence: '“指标总览”!B4:F4 · 版本 8f3…'
    }
  },

  architecture: {
    en: {
      title: 'dsh-files architecture',
      desc: 'Four-layer architecture from composer upload to local parsing and retrieval, versioned model tools, and the native vision branch.',
      headline: 'Small package. Four layers. One evidence loop.',
      subhead: 'The plugin keeps parsing and retrieval local; only selected tool evidence enters the model context.',
      columns: [
        {
          name: 'Composer',
          sub: 'Files enter once',
          items: ['Paperclip multi-select', 'Folder or page drop', '@ workspace mentions'],
          footer: 'SESSION-ISOLATED STORAGE'
        },
        {
          name: 'Local ingest',
          sub: 'Bytes decide the format',
          items: ['Content sniffing', 'Bounded parsers', 'Block + coordinate IR'],
          footer: 'PDF · DOCX · XLSX · PPTX · TEXT'
        },
        {
          name: 'Private retrieval',
          sub: 'Index once, query narrowly',
          items: ['Ordered CJK bigrams', 'SQLite FTS5 probe', 'Dependency-free fallback'],
          footer: 'QUERY LOGGING OFF BY DEFAULT'
        },
        {
          name: 'Model tools',
          sub: 'Evidence, not full documents',
          items: ['search_documents', 'read_document', 'Versioned coordinate check'],
          footer: 'EXPLICIT TRUNCATION + LIMITS'
        }
      ],
      vision: ['IMAGES', 'Harness native attachment rail', 'Provider-neutral image_url', 'Any declared vision-capable model']
    },
    zh: {
      title: 'dsh-files 架构',
      desc: '四层架构：从输入框上传，到本地解析与检索、带版本的模型工具，以及原生视觉分支。',
      headline: '小体积。四层结构。一个证据闭环。',
      subhead: '解析与检索都留在本机；只有被选中的工具证据才进入模型上下文。',
      columns: [
        {
          name: '输入框',
          sub: '文件只进来一次',
          items: ['回形针多选', '文件夹 / 页面拖放', '@ 工作区候选'],
          footer: '按会话隔离存储'
        },
        {
          name: '本地摄取',
          sub: '字节决定格式',
          items: ['内容嗅探', '有界解析器', '切块 + 坐标'],
          footer: 'PDF · DOCX · XLSX · PPTX · TEXT'
        },
        {
          name: '私有检索',
          sub: '索引一次，只查所需',
          items: ['有序中文 bigram', 'SQLite FTS5 探针', '零依赖 JS 回退'],
          footer: '检索词默认不落盘'
        },
        {
          name: '模型工具',
          sub: '只给证据，不给全文',
          items: ['search_documents', 'read_document', '带版本坐标校验'],
          footer: '截断与上限一律显式'
        }
      ],
      vision: ['图片', 'Harness 原生附件栏', '供应商中立的 image_url', '任何声明支持视觉的模型']
    }
  },

  'evidence-loop': {
    en: {
      title: 'dsh-files model evidence loop',
      desc: 'The recommended model behavior: inventory attached files, search narrowly, expand an exact coordinate with its version, and answer from evidence.',
      headline: 'The model reads less—and knows where every fact came from.',
      subhead: 'A compact tool contract replaces repeated full-document scans.',
      cards: [
        {
          name: 'Inventory',
          prompt: 'No question yet?',
          chip: 'search_documents',
          chipSub: 'file_paths only',
          notes: ['Build the private index and', 'return a compact inventory.']
        },
        {
          name: 'Retrieve',
          prompt: 'Ask a short, exact query.',
          chip: 'query: “Q3 retention”',
          chipSub: 'top evidence blocks',
          notes: ['Receive text, score, format,', 'coordinate and version.']
        },
        {
          name: 'Expand',
          prompt: 'Need surrounding context?',
          chip: 'read_document',
          chipSub: 'coordinate + version',
          notes: ['Expand only that page, slide,', 'line range or Sheet!Range.']
        },
        {
          name: 'Answer',
          prompt: 'Use cited evidence only.',
          chip: 'Sheet “People”!B12:F18',
          chipSub: 'version verified',
          notes: ['If retrieval is empty, retry', 'or state that evidence is absent.']
        }
      ]
    },
    zh: {
      title: 'dsh-files 模型证据循环',
      desc: '推荐的模型行为：先盘点附件、再精确检索、按坐标与版本展开，最后只依据证据回答。',
      headline: '模型读得更少，每条结论都知道出处。',
      subhead: '一套紧凑的工具约定，取代反复的全文扫描。',
      cards: [
        {
          name: '盘点',
          prompt: '还没有具体问题？',
          chip: 'search_documents',
          chipSub: '只传 file_paths',
          notes: ['建立私有索引，', '只返回紧凑清单。']
        },
        {
          name: '检索',
          prompt: '给一个短而准的查询。',
          chip: 'query：“Q3 留任”',
          chipSub: '返回排序证据块',
          notes: ['拿到文本、评分、格式、', '坐标和版本。']
        },
        {
          name: '展开',
          prompt: '需要上下文？',
          chip: 'read_document',
          chipSub: '坐标 + 版本',
          notes: ['只展开那一页、那张幻灯片、', '那段行区间或 Sheet!Range。']
        },
        {
          name: '回答',
          prompt: '只用已引用的证据。',
          chip: '“人员”!B12:F18',
          chipSub: '版本已校验',
          notes: ['零召回就换词重试，', '或直说材料里没有证据。']
        }
      ]
    }
  }
}
