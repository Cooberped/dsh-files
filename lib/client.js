window.__ModuleLoader__.load({ id: "dsh-files", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/reference.ts
function isRepresentableFileRef(ref) {
  return ref !== "" && !/[\u0000-\u001f\u007f-\u009f"]/u.test(ref);
}
function modelFileMention(ref) {
  if (!isRepresentableFileRef(ref)) {
    throw new Error("file path contains characters unsupported by the Harness @file grammar");
  }
  return /\s/u.test(ref) ? `@"${ref}"` : `@${ref}`;
}

// src/client/drop.ts
var RASTER_MIME_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
var RASTER_FILE_NAME = /\.(?:png|jpe?g|webp|gif)$/iu;
function list(value) {
  return value === null || value === void 0 ? [] : Array.from(value);
}
function canonicalFileIdentity(value) {
  return value.normalize("NFC");
}
function isRasterImage(file) {
  const type = (file.type ?? "").toLowerCase();
  return RASTER_MIME_TYPES.has(type) || RASTER_FILE_NAME.test(file.name);
}
function hasFileTransfer(transfer) {
  return transfer !== null && list(transfer.types).includes("Files");
}
function entryFor(item) {
  try {
    return item.webkitGetAsEntry?.() ?? null;
  } catch {
    return null;
  }
}
function fileFor(item) {
  try {
    return item.getAsFile();
  } catch {
    return null;
  }
}
function shouldOwnDocumentDrop(transfer) {
  if (!hasFileTransfer(transfer) || transfer === null) return false;
  const items = list(transfer.items).filter((item) => item.kind === "file");
  for (const item of items) {
    const entry = entryFor(item);
    if (entry?.isDirectory === true) return true;
    const file = fileFor(item);
    if (file !== null) {
      if (!isRasterImage(file)) return true;
      continue;
    }
    const type = (item.type ?? "").toLowerCase();
    if (type !== "" && !RASTER_MIME_TYPES.has(type)) return true;
    const name = entry?.name ?? "";
    if (name !== "" && !RASTER_FILE_NAME.test(name)) return true;
    if (type === "" && name === "") return true;
  }
  for (const file of list(transfer.files)) {
    if (!isRasterImage(file)) return true;
  }
  return false;
}
async function collectDroppedFiles(transfer) {
  const files = [];
  if (transfer === null) return files;
  const itemSnapshots = list(transfer.items).filter((item) => item.kind === "file").map((item) => ({ entry: entryFor(item), file: fileFor(item) }));
  const fallbackFiles = list(transfer.files);
  const gotPaths = /* @__PURE__ */ new Set();
  const gotFingerprints = /* @__PURE__ */ new Set();
  const gotObjects = /* @__PURE__ */ new WeakSet();
  const addFile = (file, entryPath = "", fallback = false) => {
    if (gotObjects.has(file)) return;
    const pathKey = canonicalFileIdentity(entryPath || file.webkitRelativePath || file.name);
    const fingerprint = [
      canonicalFileIdentity(file.name),
      file.type.toLowerCase(),
      file.size,
      file.lastModified
    ].join("\0");
    if (gotPaths.has(pathKey) || fallback && gotFingerprints.has(fingerprint)) return;
    gotObjects.add(file);
    gotPaths.add(pathKey);
    gotFingerprints.add(fingerprint);
    files.push(file);
  };
  const visit = async (entry) => {
    if (entry.isFile) {
      const fileEntry = entry;
      const file = await new Promise((resolve) => fileEntry.file(resolve));
      if (file !== null) addFile(file, fileEntry.fullPath);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve));
        if (batch === null || batch.length === 0) break;
        for (const child of batch) await visit(child);
      }
    }
  };
  for (const snapshot of itemSnapshots) {
    if (snapshot.file !== null) {
      addFile(snapshot.file, snapshot.entry?.fullPath ?? "");
      continue;
    }
    if (snapshot.entry !== null) await visit(snapshot.entry);
  }
  for (const file of fallbackFiles) addFile(file, "", true);
  return files;
}

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var SOURCE_NAME = "dsh-files";
var STYLE_TAG = "dsh-files/style.css";
var UPLOAD_CONCURRENCY = 4;
var uploadMeta = /* @__PURE__ */ new Map();
var uploadedPool = /* @__PURE__ */ new Map();
var pendingSeq = 0;
var pendingSnapshot = [];
var pendingListeners = /* @__PURE__ */ new Set();
function subscribePending(listener) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}
function publishPending(next) {
  pendingSnapshot = next;
  for (const listener of pendingListeners) listener();
}
function beginPending(file, sessionId) {
  const id = `upload-${Date.now().toString(36)}-${++pendingSeq}`;
  publishPending([...pendingSnapshot, { id, name: file.name, bytes: file.size, sessionId, status: "uploading" }]);
  return id;
}
function finishPending(id) {
  publishPending(pendingSnapshot.filter((item) => item.id !== id));
}
function failPending(id, error) {
  publishPending(pendingSnapshot.map((item) => item.id === id ? { ...item, status: "error", error } : item));
}
function dismissPending(id) {
  finishPending(id);
}
var currentSessionId = "";
var WORKSPACE_CACHE_MS = 3e4;
var workspaceCache = null;
async function fetchWorkspaceFiles() {
  if (currentSessionId === "") return [];
  const now = Date.now();
  if (workspaceCache !== null && workspaceCache.sessionId === currentSessionId && now - workspaceCache.at < WORKSPACE_CACHE_MS) {
    return workspaceCache.files;
  }
  try {
    const res = await fetch(`/api/workspace-files?session=${encodeURIComponent(currentSessionId)}`, {
      headers: { accept: "application/json" }
    });
    if (!res.ok) return [];
    const payload = await res.json();
    const files = Array.isArray(payload.files) ? payload.files.filter(isRepresentableFileRef).map((rel) => ({ rel, name: nameFromPath(rel) })) : [];
    workspaceCache = { sessionId: currentSessionId, files, at: now };
    return files;
  } catch {
    return [];
  }
}
var uploadError = null;
var errorSeq = 0;
var errorListeners = /* @__PURE__ */ new Set();
function subscribeErrors(listener) {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}
function setUploadError(text) {
  uploadError = { seq: ++errorSeq, text };
  for (const listener of errorListeners) listener();
}
function clearUploadError() {
  uploadError = null;
  for (const listener of errorListeners) listener();
}
function badgeStyle(name, sniffed) {
  if (sniffed === "pdf") return { bg: "#C93B2E", ext: "PDF" };
  if (sniffed === "docx") return { bg: "#2B579A", ext: "DOC" };
  if (sniffed === "xlsx") return { bg: "#217346", ext: "XLS" };
  if (sniffed === "pptx") return { bg: "#D24726", ext: "PPT" };
  if (sniffed === "text") return { bg: "#757575", ext: "TXT" };
  if (sniffed === null) return { bg: "#5B7DB1", ext: "FILE" };
  const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase().slice(0, 4);
  const lower = ext.toLowerCase();
  if (lower === "pdf") return { bg: "#C93B2E", ext: "PDF" };
  if (lower === "docx" || lower === "doc") return { bg: "#2B579A", ext: "DOC" };
  if (lower === "xlsx" || lower === "xls" || lower === "csv") return { bg: "#217346", ext: "XLS" };
  if (lower === "pptx" || lower === "ppt") return { bg: "#D24726", ext: "PPT" };
  if (lower === "txt" || lower === "md") return { bg: "#757575", ext: "TXT" };
  if (lower === "zip") return { bg: "#7A5BB0", ext: "ZIP" };
  return { bg: "#5B7DB1", ext: ext === "" ? "FILE" : ext };
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function nameFromPath(path) {
  const base = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  return base === "" ? path : base;
}
function readyLabel(meta) {
  if (meta?.sniffed === "pdf" || meta?.sniffed === "docx" || meta?.sniffed === "xlsx" || meta?.sniffed === "pptx" || meta?.sniffed === "text") {
    const size = meta.readHint?.cost === "expensive" ? " \xB7 \u5927\u6587\u4EF6" : "";
    return `AI \u53EF\u8BFB\u53D6${size}${meta.deduplicated === true ? " \xB7 \u5DF2\u53BB\u91CD" : ""}`;
  }
  if (meta?.sniffed === null) return "\u683C\u5F0F\u5F85\u786E\u8BA4";
  return "\u5DF2\u5C31\u7EEA";
}
function injectCss() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-files";
  tag.dataset.pluginCss = STYLE_TAG;
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
@keyframes dsh-files-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-files-card--uploading:before{animation:none}}
`;
  document.head.appendChild(tag);
}
function httpErrorText(status) {
  if (status === 413) return "\u6587\u4EF6\u8D85\u8FC7\u5927\u5C0F\u9650\u5236";
  if (status === 415) return "\u6587\u4EF6\u7C7B\u578B\u4E0D\u88AB\u5141\u8BB8";
  if (status === 403) return "\u4E0A\u4F20\u88AB\u670D\u52A1\u5668\u62D2\u7EDD\uFF1A\u975E\u672C\u673A/\u53D7\u4FE1\u6765\u6E90";
  if (status === 429) return "\u4E0A\u4F20\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5";
  if (status === 507) return "\u4F1A\u8BDD\u5B58\u50A8\u914D\u989D\u5DF2\u6EE1\uFF0C\u8BF7\u5220\u9664\u4E00\u4E9B\u6587\u4EF6";
  return `HTTP ${status}`;
}
async function insertReference(actx, ref, label) {
  const conversation = actx.get("conversation");
  if (conversation === void 0) throw new Error("conversation service unavailable");
  const input = conversation.input.for(actx);
  const state = input.state.getSnapshot();
  actx.emit("slash/input-insert-reference", {
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
  });
  const after = input.state.getSnapshot();
  return after.occurrences.some((o) => o.source === SOURCE_NAME && o.ref === ref);
}
async function uploadMany(actx, files, sessionId) {
  if (files.length === 0) return;
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= files.length) return;
      try {
        await attachFile(actx, files[i], sessionId, files[i].webkitRelativePath);
      } catch {
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker())
  );
}
async function attachFile(actx, file, sessionId, relPath) {
  if (isRasterImage(file)) {
    const conversation = actx.get("conversation");
    if (conversation !== void 0 && typeof conversation.createDraftImages === "function") {
      try {
        const drafts = conversation.createDraftImages([file]);
        const input = conversation.input.for(actx);
        if (drafts.length > 0 && typeof input.addImages === "function") {
          const added = input.addImages(drafts.map((d) => d.id));
          if (added) {
            clearUploadError();
            return;
          }
        }
      } catch {
      }
    }
  }
  const pendingId = beginPending(file, sessionId);
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent(file.name),
        // 文件夹上传时携带相对路径（webkitRelativePath 的目录前缀），
        // 服务端据此在会话目录内保留子目录层级；单文件上传为空。
        ...relPath !== void 0 && relPath !== "" ? { "x-file-relative-path": encodeURIComponent(relPath) } : {},
        "x-session-id": sessionId
      },
      body: file
    });
    if (!res.ok) {
      let detail = httpErrorText(res.status);
      try {
        const payload2 = await res.json();
        if (typeof payload2.error === "string") detail = payload2.error;
      } catch {
      }
      throw new Error(detail);
    }
    const payload = await res.json();
    if (typeof payload.path !== "string") throw new Error("missing path in response");
    const name = payload.name ?? file.name;
    const meta = {
      name,
      bytes: payload.bytes ?? file.size,
      sniffed: "sniffedFormat" in payload ? payload.sniffedFormat ?? null : void 0,
      sessionId: payload.sessionId ?? sessionId,
      readHint: payload.readHint,
      deduplicated: payload.deduplicated
    };
    uploadMeta.set(payload.path, meta);
    uploadedPool.set(payload.path, meta);
    clearUploadError();
    const inserted = await insertReference(actx, payload.path, name);
    if (!inserted) {
      failPending(pendingId, "\u5DF2\u4E0A\u4F20\uFF0C\u53EF\u901A\u8FC7 @ \u91CD\u65B0\u9009\u62E9");
      return;
    }
    finishPending(pendingId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failPending(pendingId, detail);
    throw new Error(`${file.name}: ${detail}`);
  }
}
function UploadButton({ attach, scope }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const inputRef = (0, import_react.useRef)(null);
  const attachRef = (0, import_react.useRef)(attach);
  attachRef.current = attach;
  const scopeRef = (0, import_react.useRef)(scope);
  scopeRef.current = scope;
  (0, import_react.useEffect)(() => {
    let ownsDrag = false;
    let dragDepth = 0;
    const reset = () => {
      ownsDrag = false;
      dragDepth = 0;
    };
    const claim = (e) => {
      if (!hasFileTransfer(e.dataTransfer)) return false;
      if (!ownsDrag) ownsDrag = shouldOwnDocumentDrop(e.dataTransfer);
      return ownsDrag;
    };
    const consume = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onDragEnter = (e) => {
      if (!claim(e)) return;
      consume(e);
      dragDepth += 1;
    };
    const onDragOver = (e) => {
      if (!claim(e)) return;
      consume(e);
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e) => {
      if (!ownsDrag) return;
      consume(e);
      dragDepth = Math.max(0, dragDepth - 1);
      const leavingViewport = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
      if (dragDepth === 0 || leavingViewport) reset();
    };
    const onDrop = (e) => {
      if (!claim(e)) return;
      consume(e);
      const transfer = e.dataTransfer;
      reset();
      window.dispatchEvent(new Event("dragend"));
      setBusy(true);
      void (async () => {
        try {
          const files = await collectDroppedFiles(transfer);
          if (files.length > 0) await scopeRef.current(files);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
        setBusy(false);
      })();
    };
    const onDragEnd = () => reset();
    document.addEventListener("dragenter", onDragEnter, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("dragleave", onDragLeave, true);
    document.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", onDragEnd, true);
    return () => {
      document.removeEventListener("dragenter", onDragEnter, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", onDragEnd, true);
    };
  }, []);
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    inputRef.current = input;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      inputRef.current = null;
      if (files.length === 0) return;
      setBusy(true);
      void (async () => {
        try {
          await scopeRef.current(files);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
        setBusy(false);
      })();
    };
    input.click();
  };
  const pickDir = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.display = "none";
    document.body.appendChild(input);
    inputRef.current = input;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      inputRef.current = null;
      if (files.length === 0) return;
      setBusy(true);
      void (async () => {
        try {
          await scopeRef.current(files);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
        setBusy(false);
      })();
    };
    input.click();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u4E0A\u4F20\u4E2D\u2026" : "\u4E0A\u4F20\u6587\u4EF6", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-btn", "aria-label": "\u4E0A\u4F20\u6587\u4EF6", disabled: busy, onClick: pick, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPaperclipOutline16, { size: 14 }) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: busy ? "\u4E0A\u4F20\u4E2D\u2026" : "\u4E0A\u4F20\u6587\u4EF6\u5939", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-btn", "aria-label": "\u4E0A\u4F20\u6587\u4EF6\u5939", disabled: busy, onClick: pickDir, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutline16, { size: 14 }) }) })
  ] });
}
function UploadDock({ useInput, inputActions }) {
  const state = useInput?.((s) => s) ?? null;
  const error = (0, import_react.useSyncExternalStore)(subscribeErrors, () => uploadError);
  const pending = (0, import_react.useSyncExternalStore)(subscribePending, () => pendingSnapshot).filter((item) => item.sessionId === currentSessionId);
  const ours = (state?.occurrences ?? []).filter((o) => o.source === SOURCE_NAME);
  const refs = ours.map((o) => o.ref).join("\n");
  (0, import_react.useEffect)(() => {
    const live = new Set(refs.split("\n").filter((r) => r !== ""));
    for (const key of [...uploadMeta.keys()]) {
      if (!live.has(key)) uploadMeta.delete(key);
    }
  }, [refs]);
  if (ours.length === 0 && pending.length === 0 && error === null) return null;
  const removeCard = (ref, offset, length) => {
    const draft = state?.draft ?? "";
    const next = draft.slice(0, offset) + draft.slice(offset + length);
    inputActions?.setDraft(next);
    const meta = uploadMeta.get(ref);
    uploadMeta.delete(ref);
    uploadedPool.delete(ref);
    if (meta !== void 0) {
      void fetch(`/api/upload?path=${encodeURIComponent(ref)}`, {
        method: "DELETE",
        headers: { "x-session-id": meta.sessionId }
      }).catch(() => {
      });
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-dock", children: [
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-error", role: "alert", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-error-text", title: error.text, children: error.text }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-remove", "aria-label": "\u5173\u95ED\u9519\u8BEF\u63D0\u793A", onClick: clearUploadError, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 }) })
    ] }),
    pending.map((item) => {
      const { bg, ext } = badgeStyle(item.name);
      const failed = item.status === "error";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "div",
        {
          className: `dsh-files-card dsh-files-card--${item.status}`,
          role: failed ? "alert" : "status",
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-badge", style: { background: bg }, children: ext }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-files-details", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-name", title: item.name, children: item.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-files-meta", children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-size", children: formatBytes(item.bytes) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-status", title: item.error, children: failed ? item.error ?? "\u4E0A\u4F20\u5931\u8D25" : "\u4E0A\u4F20\u4E2D" })
              ] })
            ] }),
            failed && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-files-remove", "aria-label": "\u5173\u95ED\u4E0A\u4F20\u9519\u8BEF", onClick: () => dismissPending(item.id), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 }) })
          ]
        },
        item.id
      );
    }),
    ours.map((occ) => {
      const meta = uploadMeta.get(occ.ref);
      const name = meta?.name ?? nameFromPath(occ.ref);
      const { bg, ext } = badgeStyle(name, meta?.sniffed);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-files-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-badge", style: { background: bg }, children: ext }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-files-details", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-name", title: occ.ref, children: name }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-files-meta", children: [
            meta !== void 0 && meta.bytes > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-size", children: formatBytes(meta.bytes) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-files-status", children: readyLabel(meta) })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: "\u79FB\u9664", side: "top", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "dsh-files-remove",
            "aria-label": "\u79FB\u9664",
            onClick: () => removeCard(occ.ref, occ.offset, occ.length),
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, { size: 12 })
          }
        ) })
      ] }, occ.occurrenceId);
    })
  ] });
}
function apply(ctx) {
  injectCss();
  ctx.effect(
    () => ctx.inputTriggers.registerSource({
      trigger: "@",
      name: SOURCE_NAME,
      order: 0,
      showGroupTitle: false,
      // @ 双源：工作区文件 + 本会话已上传文件；二者都以 workspace-relative
      // path 注入，agent 按 session cwd 解析，不暴露用户绝对路径。
      // 工作区源在前、上传源在后；端点不可用时静默降级为仅上传源。
      candidates: async () => {
        const workspace = await fetchWorkspaceFiles();
        const items = [];
        for (const file of workspace) {
          items.push({
            name: file.name,
            description: `\u5DE5\u4F5C\u533A \xB7 ${file.rel}`,
            value: file.rel
          });
        }
        for (const [ref, meta] of uploadedPool.entries()) {
          if (meta.sessionId !== currentSessionId) continue;
          items.push({
            name: meta.name,
            description: `${formatBytes(meta.bytes)}${meta.sniffed ? " \xB7 " + meta.sniffed.toUpperCase() : ""}`,
            value: ref
          });
        }
        return items;
      },
      onPick: (pick) => {
        const p = pick;
        const ref = p.candidate?.value;
        if (ref === void 0 || !isRepresentableFileRef(ref)) return void 0;
        return {
          insert: {
            source: SOURCE_NAME,
            ref,
            label: p.candidate?.name ?? nameFromPath(ref),
            appearance: "file",
            clipboardText: modelFileMention(ref)
          }
        };
      },
      codec: {
        clipboardText: (ref) => modelFileMention(ref),
        serialize: async (ref) => modelFileMention(ref)
      }
    })
  );
  ctx.slots.inject(
    "conversation.input.left",
    () => ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "dsh-files-button",
        order: 0,
        inject: (sessionId) => {
          currentSessionId = sessionId;
          const actx = ctx.sessions.scope(sessionId);
          return {
            attach: (file) => attachFile(actx, file, sessionId),
            // 文件夹/多文件上传复用同一会话作用域（有界并发，见 uploadMany）。
            scope: (files) => uploadMany(actx, files, sessionId)
          };
        }
      },
      UploadButton
    )
  );
  ctx.slots.inject(
    "conversation.input.dock",
    () => ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "dsh-files-dock",
        order: 5
      },
      UploadDock
    )
  );
}
var inject = ["slots", "inputTriggers", "sessions"];
return module.exports; } });
//# sourceMappingURL=client.js.map
