// Tool-side budget tests: the per-call output character budget is split by
// format so a verbose PDF/DOCX doesn't inflate the model context to the full
// text-window allowance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOutputBudget } from '../src/tool.ts'

test('text uses the full base budget', () => {
  assert.equal(formatOutputBudget('text', 24000), 24000)
})

test('xlsx gets three-quarters of the base budget', () => {
  assert.equal(formatOutputBudget('xlsx', 24000), 18000)
})

test('pdf and docx get half the base budget', () => {
  assert.equal(formatOutputBudget('pdf', 24000), 12000)
  assert.equal(formatOutputBudget('docx', 24000), 12000)
})

test('the halving never drops below the floor for a tiny base', () => {
  assert.equal(formatOutputBudget('pdf', 3000), 2000) // Math.max(2000, floor(1500))
  assert.equal(formatOutputBudget('docx', 2000), 2000)
  assert.equal(formatOutputBudget('xlsx', 2000), 2000) // floor(1500) clamped to 2000
})
