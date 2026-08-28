import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectDroppedFiles, shouldOwnDocumentDrop } from '../src/client/drop.ts'

function file(
  name: string,
  type: string,
  options: { size?: number; lastModified?: number; webkitRelativePath?: string } = {}
): File {
  return {
    name,
    type,
    size: options.size ?? 0,
    lastModified: options.lastModified ?? 0,
    webkitRelativePath: options.webkitRelativePath ?? ''
  } as File
}

function transfer(files: File[], items: DataTransferItem[] = []): DataTransfer {
  return { types: ['Files'], files, items } as unknown as DataTransfer
}

function itemFor(value: File): DataTransferItem {
  const entry = {
    isFile: true,
    isDirectory: false,
    name: value.name,
    fullPath: `/${value.name}`,
    file: (callback: (file: File) => void) => callback(value)
  } as FileSystemFileEntry
  return {
    kind: 'file',
    type: value.type,
    getAsFile: () => value,
    webkitGetAsEntry: () => entry
  } as unknown as DataTransferItem
}

test('pure raster drops stay with the Harness native image pipeline', () => {
  assert.equal(shouldOwnDocumentDrop(transfer([
    file('a.png', 'image/png'),
    file('b.jpg', 'image/jpeg')
  ])), false)
})

test('document, mixed and directory drops are owned by dsh-files', () => {
  assert.equal(shouldOwnDocumentDrop(transfer([file('a.pdf', 'application/pdf')])), true)
  assert.equal(shouldOwnDocumentDrop(transfer([
    file('a.png', 'image/png'),
    file('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ])), true)
  const directory = {
    kind: 'file',
    type: '',
    getAsFile: () => null,
    webkitGetAsEntry: () => ({ isFile: false, isDirectory: true, name: 'reports', fullPath: '/reports' })
  } as DataTransferItem
  assert.equal(shouldOwnDocumentDrop(transfer([], [directory])), true)
})

test('collectDroppedFiles merges partial items with files and keeps all three documents', async () => {
  const pdf = file('one.pdf', 'application/pdf')
  const docx = file('two.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const xlsx = file('three.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  // Simulate Finder/browser disagreement: items exposes one entry while files
  // exposes the complete selection. The common PDF must not be duplicated.
  const result = await collectDroppedFiles(transfer([pdf, docx, xlsx], [itemFor(pdf)]))
  assert.deepEqual(result.map((entry) => entry.name), ['one.pdf', 'two.docx', 'three.xlsx'])
})

test('collectDroppedFiles snapshots Finder files before drag data expires', async () => {
  const pdf = file('one.pdf', 'application/pdf')
  const docx = file('two.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const xlsx = file('three.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  let live = true
  const transient = {
    types: ['Files'],
    get files() {
      return live ? [pdf, docx, xlsx] : []
    },
    get items() {
      return live ? [itemFor(pdf)] : []
    }
  } as unknown as DataTransfer

  // Chromium protects/clears the drag store when the drop dispatch ends. The
  // first FileSystemEntry await yields to this transition.
  queueMicrotask(() => {
    live = false
  })

  const result = await collectDroppedFiles(transient)
  assert.deepEqual(result.map((entry) => entry.name), ['one.pdf', 'two.docx', 'three.xlsx'])
})

test('collectDroppedFiles treats Finder NFD and browser NFC views as one file', async () => {
  const nfcName = '流程绩效-Café.pdf'
  const nfdName = nfcName.normalize('NFD')
  assert.notEqual(nfdName, nfcName)
  const itemView = file(nfdName, 'application/pdf', { size: 42, lastModified: 7 })
  const filesView = file(nfcName, 'application/pdf', { size: 42, lastModified: 7 })

  const result = await collectDroppedFiles(transfer([filesView], [itemFor(itemView)]))

  assert.equal(result.length, 1)
  assert.equal(result[0], itemView)
})

test('text drags are ignored', () => {
  assert.equal(shouldOwnDocumentDrop({ types: ['text/plain'], files: [], items: [] } as unknown as DataTransfer), false)
})
