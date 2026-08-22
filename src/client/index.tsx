// dsh-files client face: composer paperclip button + floating file cards.
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-filess/<sessionId>), where the agent's fs backend can
// always resolve them.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip, IconPaperclipOutline16, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

const SOURCE_NAME = 'dsh-files'
const STYLE_TAG = 'dsh-files/style.css'

interface UploadMeta {
  name: string
  bytes: number
  /** 真实字节嗅探结果；undefined = 旧 host 未返回该字段。 */
  sniffed?: string | null
}

const uploadMeta = new Map<string, UploadMeta>()
// @ 文件候选池：记录本浏览器会话已上传的全部文件（含未插入草稿的）。
// 与 uploadMeta（卡片显示 + 只保留被引用项）分离，避免清理逻辑把未引用文件从候选里清掉。
const uploadedPool = new Map<string, UploadMeta>()
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
.dsh-files-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset);display:flex;flex-wrap:wrap;gap:8px;flex:none}
.dsh-files-card{position:relative;flex-direction:column;align-items:center;gap:5px;width:88px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:12px;padding:12px 8px 9px;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}
.dsh-files-badge{width:44px;height:56px;border-radius:6px;color:#fff;font-size:12px;font-weight:700;font-family:var(--ds-font-family-code,monospace);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;flex:none;box-shadow:inset 0 -10px 14px rgba(0,0,0,.14),inset 0 10px 12px rgba(255,255,255,.16)}
.dsh-files-name{width:100%;font-size:12px;line-height:16px;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.dsh-files-size{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;flex:none}
.dsh-files-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-files-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-files-card>.dsh-files-remove{position:absolute;top:4px;right:4px}
.dsh-files-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-files-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.uV2eYG_chip:has(> .uV2eYG_chipLabel:empty){visibility:hidden}
body.dsh-files-dragging:after{content:'松开以上传文件';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;background:rgba(0,0,0,.45);z-index:9999;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.5)}
`
  document.head.appendChild(tag)
}

interface InputSnapshot {
  draft: string
  draftRev: number
  occurrences: Array<{ source: string; ref: string; occurrenceId: string; offset: number }>
}

interface InputService {
  for(actx: unknown): {
    state: { getSnapshot(): InputSnapshot }
  }
}

interface ConversationService {
  input: InputService
}

interface ActionContext {
  get(name: string): ConversationService | undefined
  emit(event: string, payload: Record<string, unknown>): void
}

function httpErrorText(status: number): string {
  if (status === 413) return '文件超过大小限制'
  if (status === 415) return '文件类型不被允许'
  if (status === 403) return '会话校验失败，请刷新页面重试'
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
      clipboardText: ref
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

async function attachFile(actx: ActionContext, file: File, sessionId: string): Promise<void> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(file.name),
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
    throw new Error(`${file.name}: ${detail}`)
  }
  const payload = (await res.json()) as { path: string; name?: string; bytes?: number; sniffedFormat?: string | null }
  if (typeof payload.path !== 'string') throw new Error('missing path in response')
  const name = payload.name ?? file.name
  const meta = {
    name,
    bytes: payload.bytes ?? file.size,
    sniffed: 'sniffedFormat' in payload ? (payload.sniffedFormat ?? null) : undefined
  }
  uploadMeta.set(payload.path, meta)
  uploadedPool.set(payload.path, meta)
  clearUploadError()
  const inserted = await insertReference(actx, payload.path, '')
  if (!inserted) {
    setUploadError(`文件已上传但未能加入输入框: ${payload.path}`)
  }
}

interface UploadButtonProps {
  attach: (file: File) => Promise<void>
}

function UploadButton({ attach }: UploadButtonProps) {
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const attachRef = useRef(attach)
  attachRef.current = attach

  // 整页拖拽上传：drop 任意文件走同一上传管线（attachRef 保证监听不重挂）。
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
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      dragDepth = 0
      document.body.classList.remove('dsh-files-dragging')
      setBusy(true)
      void (async () => {
        for (const file of files) {
          try {
            await attachRef.current(file)
          } catch {
            // per-file error surfaced via the dock banner
          }
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
        for (const file of files) {
          try {
            await attach(file)
          } catch {
            // per-file error surfaced via the dock banner
          }
        }
        setBusy(false)
      })()
    }
    input.click()
  }
  return (
    <Tooltip label={busy ? '上传中…' : '上传文件'} side="top">
      <button type="button" className="dsh-files-btn" aria-label="上传文件" disabled={busy} onClick={pick}>
        <IconPaperclipOutline16 size={14} />
      </button>
    </Tooltip>
  )
}

interface DockProps {
  useInput?: (selector: (s: InputSnapshot) => InputSnapshot) => InputSnapshot | null
  inputActions?: { setDraft(text: string): void }
}

function UploadDock({ useInput, inputActions }: DockProps) {
  const state = useInput?.((s) => s) ?? null
  const error = useSyncExternalStore(subscribeErrors, () => uploadError)
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

  if (ours.length === 0 && error === null) return null

  const removeCard = (ref: string, offset: number) => {
    // 引用 token 是插入到 draft 的裸路径；occurrence 只给 offset 不给长度，
    // 所以从 offset 向后扫到空白/行尾，删掉整个 token，而不是只删 1 个字符。
    const draft = state?.draft ?? ''
    let end = offset
    while (end < draft.length && !/\s/.test(draft[end])) end += 1
    const next = draft.slice(0, offset) + draft.slice(end)
    inputActions?.setDraft(next)
    uploadMeta.delete(ref)
    uploadedPool.delete(ref)
    void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, { method: 'DELETE' }).catch(() => {})
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
      {ours.map((occ) => {
        const meta = uploadMeta.get(occ.ref)
        const name = meta?.name ?? nameFromPath(occ.ref)
        const { bg, ext } = badgeStyle(name, meta?.sniffed)
        return (
          <div className="dsh-files-card" key={occ.occurrenceId}>
            <span className="dsh-files-badge" style={{ background: bg }}>
              {ext}
            </span>
            <span className="dsh-files-name" title={occ.ref}>
              {name}
            </span>
            {meta !== undefined && meta.bytes > 0 && (
              <span className="dsh-files-size">{formatBytes(meta.bytes)}</span>
            )}
            <Tooltip label="移除" side="top">
              <button
                type="button"
                className="dsh-files-remove"
                aria-label="移除"
                onClick={() => removeCard(occ.ref, occ.offset)}
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
      // @ 文件：列出本浏览器会话已上传的文件，选中后插入路径引用，模型据此调 read_document。
      candidates: async () =>
        Array.from(uploadedPool.entries()).map(([ref, meta]) => ({
          name: meta.name,
          description: `${formatBytes(meta.bytes)}${meta.sniffed ? ' · ' + meta.sniffed.toUpperCase() : ''}`,
          value: ref
        })),
      onPick: (pick) => {
        const p = pick as { candidate?: { value?: string; name?: string } }
        const ref = p.candidate?.value
        if (ref === undefined || ref === '') return undefined
        return {
          insert: {
            source: SOURCE_NAME,
            ref,
            label: p.candidate?.name ?? nameFromPath(ref),
            appearance: 'file',
            clipboardText: ref
          }
        }
      },
      codec: {
        clipboardText: (ref: string) => ref,
        serialize: async (ref: string) => ref
      }
    })
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-files-button',
        order: 0,
        inject: (sessionId: string) => ({
          attach: (file: File) => attachFile(ctx.sessions.scope(sessionId), file, sessionId)
        })
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

// 修复：client bundle 必须导出插件对象，否则 cordis 报
// "invalid plugin, expect function or object with an apply method"。
// esbuild iife 格式不会自动把 entry 导出写入 module.exports，
// 这里显式赋值（banner 已定义 module 变量，运行时存在）。
// 参考官方双面插件：exports.apply = apply; exports.inject = inject;
declare const module: { exports: unknown } | undefined
if (typeof module !== 'undefined' && module !== null) {
  module.exports = {
    apply,
    inject: ['slots', 'inputTriggers', 'sessions']
  }
}
