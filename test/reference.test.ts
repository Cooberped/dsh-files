import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRepresentableFileRef, modelFileMention } from '../src/reference.ts'

test('modelFileMention follows Harness @file quoting rules', () => {
  assert.equal(modelFileMention('.dsh-filess/s1/report.xlsx'), '@.dsh-filess/s1/report.xlsx')
  assert.equal(modelFileMention('.dsh-filess/s1/季度 复盘.xlsx'), '@".dsh-filess/s1/季度 复盘.xlsx"')
})

test('modelFileMention fails closed for unrepresentable paths', () => {
  assert.equal(isRepresentableFileRef('ok/path.pdf'), true)
  assert.equal(isRepresentableFileRef('bad"path.pdf'), false)
  assert.throws(() => modelFileMention('bad\npath.pdf'), /unsupported/)
})
