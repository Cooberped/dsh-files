// dsh-files client face: composer paperclip button + floating file cards.
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-filess/<sessionId>), where the agent's fs backend can
// always resolve them.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip, IconPaperclipOutline16, IconCloseOutline16, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { isRepresentableFileRef, modelFileMention } from '../reference.ts'

const SOURCE_NAME = 'dsh-files'
const STYLE_TAG = 'dsh-files/style.css'
// 文件夹拖入/选中时，逐文件上传的有界并发上限。
// 服务端 maxConcurrentUploads 默认 4：超过会被 429，这里取同值，
// 避免整批重试；并发不提升网络吞吐，只消除「串行等待」的排队墙钟时间。
const UPLOAD_CONCURRENCY = 4

interface UploadMeta {
  name: string
  bytes: number
  /** 真实字节嗅探结果；undefined = 旧 host 未返回该字段。 */
  sniffed?: string | null
  /** 上传时所属会话；@ 候选只列当前会话的文件，避免跨会话泄漏。 */
  sessionId: string
  readHint?: { cost: 'cheap' | 'moderate' | 'expensive'; estimatedChars: number }
  deduplicated?: boolean
}

interface PendingUpload {
  id: string
  name: string
  bytes: number
  sessionId: string
  status: 'uploading' | 'error'
  error?: string
}

const uploadMeta = new Map<string, UploadMeta>()
// @ 文件候选池：记录本浏览器会话已上传的全部文件（含未插入草稿的）。
// 与 uploadMeta（卡片显示 + 只保留被引用项）分离，避免清理逻辑把未引用文件从候选里清掉。
// 每条带 sessionId，候选按当前会话过滤。
const uploadedPool = new Map<string, UploadMeta>()
let pendingSeq = 0
let pendingSnapshot: readonly PendingUpload[] = []
const pendingListeners = new Set<() => void>()

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

function publishPending(next: readonly PendingUpload[]): void {
  pendingSnapshot = next
  for (const listener of pendingListeners) listener()
}

function beginPending(file: File, sessionId: string): string {
  const id = `upload-${Date.now().toString(36)}-${++pendingSeq}`
  publishPending([...pendingSnapshot, { id, name: file.name, bytes: file.size, sessionId, status: 'uploading' }])
  return id
}

function finishPending(id: string): void {
  publishPending(pendingSnapshot.filter((item) => item.id !== id))
}

function failPending(id: string, error: string): void {
  publishPending(pendingSnapshot.map((item) => item.id === id ? { ...item, status: 'error', error } : item))
}

function dismissPending(id: string): void {
  finishPending(id)
}
// @ 双源的第二源：工作区文件。缓存 30 秒且绑定会话（换会话即失效），
// 避免每次 @ 都重建 BFS 索引，也避免把上一个会话的工作区文件串进当前会话。
let currentSessionId = ''
const WORKSPACE_CACHE_MS = 30_000
let workspaceCache: { sessionId: string; files: Array<{ rel: string; name: string }>; at: number } | null = null

interface WorkspaceFile {
  rel: string
  name: string
}

async function fetchWorkspaceFiles(): Promise<WorkspaceFile[]> {
  if (currentSessionId === '') return []
  const now = Date.now()
  if (workspaceCache !== null && workspaceCache.sessionId === currentSessionId && now - workspaceCache.at < WORKSPACE_CACHE_MS) {
    return workspaceCache.files
  }
  try {
    const res = await fetch(`/api/workspace-files?session=${encodeURIComponent(currentSessionId)}`, {
      headers: { accept: 'application/json' }
    })
    if (!res.ok) return []
    const payload = (await res.json()) as { files?: string[] }
    const files = Array.isArray(payload.files)
      ? payload.files.filter(isRepresentableFileRef).map((rel) => ({ rel, name: nameFromPath(rel) }))
      : []
    workspaceCache = { sessionId: currentSessionId, files, at: now }
    return files
  } catch {
    // 索引端点不可用（旧 host / 未挂载）时静默降级为仅上传源。
    return []
  }
}
let uploadError: { seq: number; text: string } | null = null
let errorSeq = 0
const errorListeners = new Set<() => void>()

function subscribeErrors(listener: () => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function setUploadError(text: string): void {
  uploadError = { seq: ++errorSeq, text }
  for (const listener of errorListeners) listener()
}

function clearUploadError(): void {
  uploadError = null
  for (const listener of errorListeners) listener()
}

function badgeStyle(name: string, sniffed?: string | null): { bg: string; ext: string } {
  // 真实格式优先于扩展名：伪装文件（exe 改 .pdf）按真实内容着色。
  if (sniffed === 'pdf') return { bg: '#C93B2E', ext: 'PDF' }
  if (sniffed === 'docx') return { bg: '#2B579A', ext: 'DOC' }
  if (sniffed === 'xlsx') return { bg: '#217346', ext: 'XLS' }
  if (sniffed === 'text') return { bg: '#757575', ext: 'TXT' }
  // sniffed 字段存在但为 null（未知/二进制）：拒绝按扩展名伪装显示。
  if (sniffed === null) return { bg: '#5B7DB1', ext: 'FILE' }
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4)
  const lower = ext.toLowerCase()
  if (lower === 'pdf') return { bg: '#C93B2E', ext: 'PDF' }
  if (lower === 'docx' || lower === 'doc') return { bg: '#2B579A', ext: 'DOC' }
  if (lower === 'xlsx' || lower === 'xls' || lower === 'csv') return { bg: '#217346', ext: 'XLS' }
  if (lower === 'txt' || lower === 'md') return { bg: '#757575', ext: 'TXT' }
  if (lower === 'zip') return { bg: '#7A5BB0', ext: 'ZIP' }
  return { bg: '#5B7DB1', ext: ext === '' ? 'FILE' : ext }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function nameFromPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
  return base === '' ? path : base
}

function readyLabel(meta?: UploadMeta): string {
  if (meta?.sniffed === 'pdf' || meta?.sniffed === 'docx' || meta?.sniffed === 'xlsx' || meta?.sniffed === 'text') {
    const size = meta.readHint?.cost === 'expensive' ? ' · 大文件' : ''
    return `AI 可读取${size}${meta.deduplicated === true ? ' · 已去重' : ''}`
  }
  if (meta?.sniffed === null) return '格式待确认'
  return '已就绪'
}

/**
 * Whether a browser file is one of the raster formats the harness native
 * visual pipeline accepts (JPEG/PNG/WebP/GIF). Image files take the native
 * attachment rail (base64 → visual model); everything else stays on the local
 * document path (read_document). Native check first (MIME), then extension,
 * because dropped files sometimes carry an empty `type`.
 */
function isRasterImage(file: File): boolean {
  const t = (file.type ?? '').toLowerCase()
  if (t === 'image/png' || t === 'image/jpeg' || t === 'image/webp' || t === 'image/gif') return true
  return /\.(png|jpe?g|webp|gif)$/.test(file.name.toLowerCase())
}

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-files'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = `
.dsh-files-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;border-radius:6px;padding:4px;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dsh-files-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor)}
.dsh-files-btn:disabled{opacity:.45;cursor:default}
.dsh-files-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 7px;padding:0 var(--dsh-composer-dock-inset);display:flex;flex-wrap:wrap;gap:7px;flex:none}
.dsh-files-card{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:9px;width:236px;max-width:100%;min-height:58px;flex:none;overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:11px;padding:8px 8px 8px 11px;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}
.dsh-files-card:before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:#35a568}
.dsh-files-card--uploading:before{background:#4f7de8;animation:dsh-files-pulse 1.25s ease-in-out infinite}
.dsh-files-card--error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d86161) 45%,transparent)}
.dsh-files-card--error:before{background:var(--dsw-alias-state-error-primary,#d86161)}
.dsh-files-badge{width:34px;height:42px;border-radius:6px;color:#fff;font-size:10.5px;font-weight:700;font-family:var(--ds-font-family-code,monospace);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.35px;flex:none;box-shadow:inset 0 -8px 12px rgba(0,0,0,.14),inset 0 8px 10px rgba(255,255,255,.14)}
.dsh-files-details{min-width:0;display:flex;flex:1;flex-direction:column;gap:3px}
.dsh-files-name{width:100%;font-size:12.5px;line-height:17px;font-weight:520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-files-meta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;line-height:14px}
.dsh-files-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-files-status:before{content:'';display:inline-block;width:5px;height:5px;margin:0 5px 1px 0;border-radius:50%;background:#35a568}
.dsh-files-card--uploading .dsh-files-status:before{background:#4f7de8}
.dsh-files-card--error .dsh-files-status{color:var(--dsw-alias-state-error-primary,#d86161)}
.dsh-files-card--error .dsh-files-status:before{background:var(--dsw-alias-state-error-primary,#d86161)}
.dsh-files-size{white-space:nowrap;flex:none}
.dsh-files-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-files-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-files-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-files-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
body.dsh-files-dragging:after{content:'松开以上传文件或文件夹';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);z-index:9999;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.5)}
@keyframes dsh-files-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-files-card--uploading:before{animation:none}}
`
  document.head.appendChild(tag)
}

interface InputSnapshot {
  draft: string
  draftRev: number
  occurrences: Array<{ source: string; ref: string; occurrenceId: number; offset: number; length: number }>
}

interface InputService {
  for(actx: unknown): {
    state: { getSnapshot(): InputSnapshot }
    /** Append ordered browser-owned draft image ids into this session's draft (native attachment rail). */
    addImages(ids: string[]): boolean
  }
}

interface ConversationService {
  input: InputService
  /** Register browser files as runtime draft images (native visual pipeline hands them to the model as base64 image_url). */
  createDraftImages(files: File[]): Array<{ id: string }>
}

interface ActionContext {
  get(name: string): ConversationService | undefined
  emit(event: string, payload: Record<string, unknown>): void
}

function httpErrorText(status: number): string {
  if (status === 413) return '文件超过大小限制'
  if (status === 415) return '文件类型不被允许'
  if (status === 403) return '上传被服务器拒绝：非本机/受信来源'
  if (status === 429) return '上传太频繁，请稍后再试'
  if (status === 507) return '会话存储配额已满，请删除一些文件'
  return `HTTP ${status}`
}

/** 把文件路径插入输入框（上传与文件面板共用）。 */
async function insertReference(actx: ActionContext, ref: string, label: string): Promise<boolean> {
  const conversation = actx.get('conversation')
  if (conversation === undefined) throw new Error('conversation service unavailable')
  const input = conversation.input.for(actx)
  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-reference', {
    reference: {
      source: SOURCE_NAME,
      ref,
      label,
      clipboardText: modelFileMention(ref)
    },
    span: {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev
    }
  })
  const after = input.state.getSnapshot()
  return after.occurrences.some((o) => o.source === SOURCE_NAME && o.ref === ref)
}

/**
 * 以有界并发上传一组文件（文件夹递归收集后的结果）。
 * 服务端并发上限（默认 4）外的请求会 429，这里同值并发避免整批失败；
 * 逐文件错误照常进入 dock banner，成功项正常插入输入框。
 */
async function uploadMany(actx: ActionContext, files: readonly File[], sessionId: string): Promise<void> {
  if (files.length === 0) return
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= files.length) return
      try {
        await attachFile(actx, files[i], sessionId, files[i].webkitRelativePath)
      } catch {
        // attachFile keeps a per-file error card in the dock.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker())
  )
}

/** 从 DataTransfer 提取文件；返回时目录项已被递归展平为具体文件。 */
async function collectFiles(dt: DataTransfer | null): Promise<File[]> {
  const files: File[] = []
  if (dt === null) return files
  const items = dt.items
  const got = new Set<string>()
  const visit = async (item: DataTransferItem | FileSystemEntry): Promise<void> => {
    // DataTransferItem（拖拽列表）与 FileSystemEntry（目录递归）是两种形状：
    // 前者用 webkitGetAsEntry/getAsFile，后者直接用 isFile/isDirectory/createReader。
    if ('webkitGetAsEntry' in item) {
      const entry = item.webkitGetAsEntry?.()
      if (entry === undefined || entry === null) {
        const file = item.getAsFile()
        if (file !== null) files.push(file)
        return
      }
      await visit(entry)
      return
    }
    if (item.isFile) {
      const fileEntry = item as FileSystemFileEntry
      const file = await new Promise<File | null>((resolve) => fileEntry.file(resolve))
      if (file !== null) {
        // 去重键优先用 webkitRelativePath（含目录前缀）：同名不同目录的文件
        // 都要保留，否则按 name 去重会静默丢一个。
        const key = file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
        if (!got.has(key)) {
          got.add(key)
          files.push(file)
        }
      }
    } else if (item.isDirectory) {
      const reader = (item as FileSystemDirectoryEntry).createReader()
      // webkitGetAsEntry 的目录读取器每次 readEntries 最多返回约 100 项，
      // 必须循环读到空数组为止（目录项多时一次读不全）。
      while (true) {
        const batch = await new Promise<FileSystemEntry[] | null>((resolve) => reader.readEntries(resolve))
        if (batch === null || batch.length === 0) break
        for (const child of batch) await visit(child)
      }
    }
  }
  for (const item of Array.from(items ?? [])) {
    if (item.kind === 'file') await visit(item)
  }
  return files
}

async function attachFile(actx: ActionContext, file: File, sessionId: string, relPath?: string): Promise<void> {
  // 图片走核心原生附件管线（createDraftImages → 草稿 id → addImages → 发送时转
  // base64 image_url 给视觉模型），文档走本地路径 + read_document。这是「开关」：
  // 按文件类型分流——视觉模型默认吃到原生图片，文本模型吃到本地文档。
  // 任意原生准入失败（纯文本模型 / 无 conversation 服务）回退到本地路径。
  if (isRasterImage(file)) {
    const conversation = actx.get('conversation')
    if (conversation !== undefined && typeof conversation.createDraftImages === 'function') {
      try {
        const drafts = conversation.createDraftImages([file])
        const input = conversation.input.for(actx)
        if (drafts.length > 0 && typeof input.addImages === 'function') {
          const added = input.addImages(drafts.map((d) => d.id))
          if (added) {
            clearUploadError()
            return
          }
        }
      } catch {
        // any native admission failure falls through to the legacy local path
      }
    }
  }
  const pendingId = beginPending(file, sessionId)
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'x-file-name': encodeURIComponent(file.name),
        // 文件夹上传时携带相对路径（webkitRelativePath 的目录前缀），
        // 服务端据此在会话目录内保留子目录层级；单文件上传为空。
        ...(relPath !== undefined && relPath !== ''
          ? { 'x-file-relative-path': encodeURIComponent(relPath) }
          : {}),
        'x-session-id': sessionId
      },
      body: file
    })
    if (!res.ok) {
      let detail = httpErrorText(res.status)
      try {
        const payload = (await res.json()) as { error?: string }
        if (typeof payload.error === 'string') detail = payload.error
      } catch {
        // keep the status-based message
      }
      throw new Error(detail)
    }
    const payload = (await res.json()) as {
      path: string
      name?: string
      bytes?: number
      sniffedFormat?: string | null
      sessionId?: string
      readHint?: UploadMeta['readHint']
      deduplicated?: boolean
    }
    if (typeof payload.path !== 'string') throw new Error('missing path in response')
    const name = payload.name ?? file.name
    const meta: UploadMeta = {
      name,
      bytes: payload.bytes ?? file.size,
      sniffed: 'sniffedFormat' in payload ? (payload.sniffedFormat ?? null) : undefined,
      sessionId: payload.sessionId ?? sessionId,
      readHint: payload.readHint,
      deduplicated: payload.deduplicated
    }
    uploadMeta.set(payload.path, meta)
    uploadedPool.set(payload.path, meta)
    clearUploadError()
    const inserted = await insertReference(actx, payload.path, name)
    if (!inserted) {
      failPending(pendingId, '已上传，可通过 @ 重新选择')
      return
    }
    finishPending(pendingId)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    failPending(pendingId, detail)
    throw new Error(`${file.name}: ${detail}`)
  }
}

interface UploadButtonProps {
  attach: (file: File) => Promise<void>
  /** 本会话作用域：文件夹/多文件上传与 @ 候选共用同一会话上下文。 */
  scope: (files: readonly File[]) => Promise<void>
}

function UploadButton({ attach, scope }: UploadButtonProps) {
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const attachRef = useRef(attach)
  attachRef.current = attach
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  // 整页拖拽上传：drop 任意文件/文件夹走同一上传管线（scopeRef 保证监听不重挂）。
  useEffect(() => {
    let dragDepth = 0
    const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      dragDepth += 1
      document.body.classList.add('dsh-files-dragging')
    }
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      // 只处理真正离开 document 的 leave：元素内部的 leave 事件
      // （relatedTarget 仍在本页）不应减少 dragDepth，否则遮罩会闪断。
      if (e.relatedTarget !== null) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) document.body.classList.remove('dsh-files-dragging')
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      dragDepth = 0
      document.body.classList.remove('dsh-files-dragging')
      setBusy(true)
      void (async () => {
        try {
          const files = await collectFiles(e.dataTransfer ?? null)
          if (files.length > 0) await scopeRef.current(files)
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err))
        }
        setBusy(false)
      })()
    }
    const onDragEnd = () => {
      dragDepth = 0
      document.body.classList.remove('dsh-files-dragging')
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragend', onDragEnd)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragend', onDragEnd)
      document.body.classList.remove('dsh-files-dragging')
    }
  }, [])

  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    inputRef.current = input
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      inputRef.current = null
      if (files.length === 0) return
      setBusy(true)
      void (async () => {
        try {
          await scopeRef.current(files)
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err))
        }
        setBusy(false)
      })()
    }
    input.click()
  }

  // 文件夹选择：webkitdirectory 的文件选择器只认目录，选中后 input.files
  // 已是递归展平的相对路径列表（含 webkitRelativePath），走同一上传管线。
  const pickDir = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    ;(input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true
    input.style.display = 'none'
    document.body.appendChild(input)
    inputRef.current = input
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      inputRef.current = null
      if (files.length === 0) return
      setBusy(true)
      void (async () => {
        try {
          await scopeRef.current(files)
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err))
        }
        setBusy(false)
      })()
    }
    input.click()
  }
  return (
    <>
      <Tooltip label={busy ? '上传中…' : '上传文件'} side="top">
        <button type="button" className="dsh-files-btn" aria-label="上传文件" disabled={busy} onClick={pick}>
          <IconPaperclipOutline16 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={busy ? '上传中…' : '上传文件夹'} side="top">
        <button type="button" className="dsh-files-btn" aria-label="上传文件夹" disabled={busy} onClick={pickDir}>
          <IconFolderOpenOutline16 size={14} />
        </button>
      </Tooltip>
    </>
  )
}

interface DockProps {
  useInput?: (selector: (s: InputSnapshot) => InputSnapshot) => InputSnapshot | null
  inputActions?: { setDraft(text: string): void }
}

function UploadDock({ useInput, inputActions }: DockProps) {
  const state = useInput?.((s) => s) ?? null
  const error = useSyncExternalStore(subscribeErrors, () => uploadError)
  const pending = useSyncExternalStore(subscribePending, () => pendingSnapshot)
    .filter((item) => item.sessionId === currentSessionId)
  const ours = (state?.occurrences ?? []).filter((o) => o.source === SOURCE_NAME)
  const refs = ours.map((o) => o.ref).join('\n')

  useEffect(() => {
    // 只依赖 refs 字符串：ours 每次渲染都是新数组，放进依赖会让
    // 清理逻辑每帧重跑（性能 + 潜在的 uploadMeta 抖动）。
    const live = new Set(refs.split('\n').filter((r) => r !== ''))
    for (const key of [...uploadMeta.keys()]) {
      if (!live.has(key)) uploadMeta.delete(key)
    }
  }, [refs])

  if (ours.length === 0 && pending.length === 0 && error === null) return null

  const removeCard = (ref: string, offset: number, length: number) => {
    // Harness occurrence owns the exact display range. Use it directly so a
    // label containing spaces is removed atomically instead of leaving a
    // broken half-reference in the draft.
    const draft = state?.draft ?? ''
    const next = draft.slice(0, offset) + draft.slice(offset + length)
    inputActions?.setDraft(next)
    const meta = uploadMeta.get(ref)
    uploadMeta.delete(ref)
    uploadedPool.delete(ref)
    // 只对上传文件发删除；工作区相对路径引用不触碰 host 存储。
    if (meta !== undefined) {
      void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': meta.sessionId }
      }).catch(() => {})
    }
  }

  return (
    <div className="dsh-files-dock">
      {error !== null && (
        <div className="dsh-files-error" role="alert">
          <span className="dsh-files-error-text" title={error.text}>
            {error.text}
          </span>
          <button type="button" className="dsh-files-remove" aria-label="关闭错误提示" onClick={clearUploadError}>
            <IconCloseOutline16 size={12} />
          </button>
        </div>
      )}
      {pending.map((item) => {
        const { bg, ext } = badgeStyle(item.name)
        const failed = item.status === 'error'
        return (
          <div
            className={`dsh-files-card dsh-files-card--${item.status}`}
            key={item.id}
            role={failed ? 'alert' : 'status'}
          >
            <span className="dsh-files-badge" style={{ background: bg }}>{ext}</span>
            <span className="dsh-files-details">
              <span className="dsh-files-name" title={item.name}>{item.name}</span>
              <span className="dsh-files-meta">
                <span className="dsh-files-size">{formatBytes(item.bytes)}</span>
                <span className="dsh-files-status" title={item.error}>
                  {failed ? item.error ?? '上传失败' : '上传中'}
                </span>
              </span>
            </span>
            {failed && (
              <button type="button" className="dsh-files-remove" aria-label="关闭上传错误" onClick={() => dismissPending(item.id)}>
                <IconCloseOutline16 size={12} />
              </button>
            )}
          </div>
        )
      })}
      {ours.map((occ) => {
        const meta = uploadMeta.get(occ.ref)
        const name = meta?.name ?? nameFromPath(occ.ref)
        const { bg, ext } = badgeStyle(name, meta?.sniffed)
        return (
          <div className="dsh-files-card" key={occ.occurrenceId}>
            <span className="dsh-files-badge" style={{ background: bg }}>
              {ext}
            </span>
            <span className="dsh-files-details">
              <span className="dsh-files-name" title={occ.ref}>{name}</span>
              <span className="dsh-files-meta">
                {meta !== undefined && meta.bytes > 0 && (
                  <span className="dsh-files-size">{formatBytes(meta.bytes)}</span>
                )}
                <span className="dsh-files-status">{readyLabel(meta)}</span>
              </span>
            </span>
            <Tooltip label="移除" side="top">
              <button
                type="button"
                className="dsh-files-remove"
                aria-label="移除"
                onClick={() => removeCard(occ.ref, occ.offset, occ.length)}
              >
                <IconCloseOutline16 size={12} />
              </button>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}

export function apply(ctx: {
  effect(fn: () => unknown): void
  inputTriggers: {
    registerSource(source: Record<string, unknown>): void
  }
  slots: {
    inject(name: string, fn: () => unknown): void
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  sessions: {
    scope(sessionId: string): ActionContext
  }
}): void {
  injectCss()
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: '@',
      name: SOURCE_NAME,
      order: 0,
      showGroupTitle: false,
      // @ 双源：工作区文件 + 本会话已上传文件；二者都以 workspace-relative
      // path 注入，agent 按 session cwd 解析，不暴露用户绝对路径。
      // 工作区源在前、上传源在后；端点不可用时静默降级为仅上传源。
      candidates: async () => {
        const workspace = await fetchWorkspaceFiles()
        const items: Array<Record<string, unknown>> = []
        for (const file of workspace) {
          items.push({
            name: file.name,
            description: `工作区 · ${file.rel}`,
            value: file.rel
          })
        }
        for (const [ref, meta] of uploadedPool.entries()) {
          // 只列当前会话的文件：跨会话文件不进入本会话 @ 候选。
          if (meta.sessionId !== currentSessionId) continue
          items.push({
            name: meta.name,
            description: `${formatBytes(meta.bytes)}${meta.sniffed ? ' · ' + meta.sniffed.toUpperCase() : ''}`,
            value: ref
          })
        }
        return items
      },
      onPick: (pick: unknown) => {
        const p = pick as { candidate?: { value?: string; name?: string } }
        const ref = p.candidate?.value
        if (ref === undefined || !isRepresentableFileRef(ref)) return undefined
        return {
          insert: {
            source: SOURCE_NAME,
            ref,
            label: p.candidate?.name ?? nameFromPath(ref),
            appearance: 'file',
            clipboardText: modelFileMention(ref)
          }
        }
      },
      codec: {
        clipboardText: (ref: string) => modelFileMention(ref),
        serialize: async (ref: string) => modelFileMention(ref)
      }
    })
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-files-button',
        order: 0,
        inject: (sessionId: string) => {
          // 捕获当前会话：@ 工作区候选按会话 cwd 索引。
          currentSessionId = sessionId
          const actx = ctx.sessions.scope(sessionId)
          return {
            attach: (file: File) => attachFile(actx, file, sessionId),
            // 文件夹/多文件上传复用同一会话作用域（有界并发，见 uploadMany）。
            scope: (files: readonly File[]) => uploadMany(actx, files, sessionId)
          }
        }
      },
      UploadButton
    )
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-files-dock',
        order: 5
      },
      UploadDock
    )
  )
}

// CommonJS build output exposes this alongside apply to the Harness loader.
export const inject = ['slots', 'inputTriggers', 'sessions'] as const
