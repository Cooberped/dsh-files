// Browser drag/drop arbitration shared by the client face and focused tests.
// Harness owns pure raster-image drops. dsh-files owns any batch containing a
// document or directory, then routes raster members back through the native
// image service and documents through the local read_document path.

const RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const RASTER_FILE_NAME = /\.(?:png|jpe?g|webp|gif)$/iu

function list<T>(value: ArrayLike<T> | null | undefined): T[] {
  return value === null || value === undefined ? [] : Array.from(value)
}

export function isRasterImage(file: Pick<File, 'name' | 'type'>): boolean {
  const type = (file.type ?? '').toLowerCase()
  return RASTER_MIME_TYPES.has(type) || RASTER_FILE_NAME.test(file.name)
}

export function hasFileTransfer(transfer: DataTransfer | null): boolean {
  return transfer !== null && list(transfer.types).includes('Files')
}

function entryFor(item: DataTransferItem): FileSystemEntry | null {
  try {
    return item.webkitGetAsEntry?.() ?? null
  } catch {
    return null
  }
}

function fileFor(item: DataTransferItem): File | null {
  try {
    return item.getAsFile()
  } catch {
    return null
  }
}

/**
 * Decide synchronously during capture whether this plugin must own the drag.
 * Unknown file items fail closed to the document path; known pure raster
 * batches pass through untouched to Harness' native image admission limits.
 */
export function shouldOwnDocumentDrop(transfer: DataTransfer | null): boolean {
  if (!hasFileTransfer(transfer) || transfer === null) return false
  const items = list(transfer.items).filter((item) => item.kind === 'file')
  for (const item of items) {
    const entry = entryFor(item)
    if (entry?.isDirectory === true) return true
    const file = fileFor(item)
    if (file !== null) {
      if (!isRasterImage(file)) return true
      continue
    }
    const type = (item.type ?? '').toLowerCase()
    if (type !== '' && !RASTER_MIME_TYPES.has(type)) return true
    const name = entry?.name ?? ''
    if (name !== '' && !RASTER_FILE_NAME.test(name)) return true
    // Some engines hide both MIME and file name until drop. Owning the event
    // avoids leaking an unknown document batch into the image-only handler.
    if (type === '' && name === '') return true
  }
  for (const file of list(transfer.files)) {
    if (!isRasterImage(file)) return true
  }
  return false
}

/** Collect every dropped file from both browser views, deduplicated. */
export async function collectDroppedFiles(transfer: DataTransfer | null): Promise<File[]> {
  const files: File[] = []
  if (transfer === null) return files
  const gotPaths = new Set<string>()
  const gotFingerprints = new Set<string>()
  const gotObjects = new WeakSet<object>()
  const addFile = (file: File, entryPath = '', fallback = false) => {
    if (gotObjects.has(file)) return
    const pathKey = entryPath || file.webkitRelativePath || file.name
    const fingerprint = [file.name, file.type, file.size, file.lastModified].join('\u0000')
    if (gotPaths.has(pathKey) || (fallback && gotFingerprints.has(fingerprint))) return
    gotObjects.add(file)
    gotPaths.add(pathKey)
    gotFingerprints.add(fingerprint)
    files.push(file)
  }
  const visit = async (item: DataTransferItem | FileSystemEntry): Promise<void> => {
    if ('webkitGetAsEntry' in item) {
      const entry = entryFor(item)
      if (entry === null) {
        const file = fileFor(item)
        if (file !== null) addFile(file)
        return
      }
      await visit(entry)
      return
    }
    if (item.isFile) {
      const fileEntry = item as FileSystemFileEntry
      const file = await new Promise<File | null>((resolve) => fileEntry.file(resolve))
      if (file !== null) addFile(file, fileEntry.fullPath)
      return
    }
    if (item.isDirectory) {
      const reader = (item as FileSystemDirectoryEntry).createReader()
      while (true) {
        const batch = await new Promise<FileSystemEntry[] | null>((resolve) => reader.readEntries(resolve))
        if (batch === null || batch.length === 0) break
        for (const child of batch) await visit(child)
      }
    }
  }
  for (const item of list(transfer.items)) {
    if (item.kind === 'file') await visit(item)
  }
  // DataTransfer.items can be partial or unavailable for Finder-originated
  // multi-selection. Merge DataTransfer.files instead of treating either view
  // as authoritative; addFile removes the ordinary duplicate entries.
  for (const file of list(transfer.files)) addFile(file, '', true)
  return files
}
