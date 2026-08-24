// ParseCache tests: LRU eviction, recency refresh, version-sensitive keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ParseCache } from '../src/cache.ts'

const key = (targetKey: string, version: string, format = 'pdf') => ({ targetKey, version, format })

test('hit returns cached text, miss parses once', () => {
  const cache = new ParseCache(4)
  assert.equal(cache.get(key('a', 'v1')), undefined)
  cache.set(key('a', 'v1'), 'text-a')
  assert.equal(cache.get(key('a', 'v1')), 'text-a')
  assert.equal(cache.get(key('a', 'v1')), 'text-a') // second hit still works
})

test('a changed file version never serves stale text', () => {
  const cache = new ParseCache(4)
  cache.set(key('a', 'v1'), 'old')
  assert.equal(cache.get(key('a', 'v2')), undefined)
  cache.set(key('a', 'v2'), 'new')
  assert.equal(cache.get(key('a', 'v1')), 'old')
  assert.equal(cache.get(key('a', 'v2')), 'new')
})

test('format is part of the key', () => {
  const cache = new ParseCache(4)
  cache.set(key('a', 'v1', 'pdf'), 'pdf-text')
  cache.set(key('a', 'v1', 'text'), 'text-content')
  assert.equal(cache.get(key('a', 'v1', 'pdf')), 'pdf-text')
  assert.equal(cache.get(key('a', 'v1', 'text')), 'text-content')
})

test('LRU eviction drops the least recently used entry', () => {
  const cache = new ParseCache(2)
  cache.set(key('a', 'v1'), 'a')
  cache.set(key('b', 'v1'), 'b')
  cache.get(key('a', 'v1')) // refresh a
  cache.set(key('c', 'v1'), 'c') // evicts b
  assert.equal(cache.get(key('a', 'v1')), 'a')
  assert.equal(cache.get(key('b', 'v1')), undefined)
  assert.equal(cache.get(key('c', 'v1')), 'c')
})

test('overwriting refreshes recency', () => {
  const cache = new ParseCache(2)
  cache.set(key('a', 'v1'), 'a')
  cache.set(key('b', 'v1'), 'b')
  cache.set(key('a', 'v1'), 'a2') // refresh + replace
  cache.set(key('c', 'v1'), 'c') // evicts b
  assert.equal(cache.get(key('a', 'v1')), 'a2')
  assert.equal(cache.get(key('b', 'v1')), undefined)
})

test('clear empties the cache', () => {
  const cache = new ParseCache(4)
  cache.set(key('a', 'v1'), 'a')
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.get(key('a', 'v1')), undefined)
})

test('constructor rejects invalid capacity', () => {
  assert.throws(() => new ParseCache(0))
  assert.throws(() => new ParseCache(-1))
  assert.throws(() => new ParseCache(1.5))
})

test('sheet is part of the key', () => {
  const cache = new ParseCache(4)
  cache.set({ targetKey: 'a', version: 'v1', format: 'xlsx' }, 'merged')
  cache.set({ targetKey: 'a', version: 'v1', format: 'xlsx', sheet: 2 }, 'sheet2')
  assert.equal(cache.get({ targetKey: 'a', version: 'v1', format: 'xlsx' }), 'merged')
  assert.equal(cache.get({ targetKey: 'a', version: 'v1', format: 'xlsx', sheet: 2 }), 'sheet2')
  assert.equal(cache.get({ targetKey: 'a', version: 'v1', format: 'xlsx', sheet: 3 }), undefined)
})

test('listSheets is part of the key', () => {
  const cache = new ParseCache(4)
  cache.set({ targetKey: 'a', version: 'v1', format: 'xlsx' }, 'merged')
  cache.set({ targetKey: 'a', version: 'v1', format: 'xlsx', listSheets: true }, 'sheet-list')
  assert.equal(cache.get({ targetKey: 'a', version: 'v1', format: 'xlsx' }), 'merged')
  assert.equal(cache.get({ targetKey: 'a', version: 'v1', format: 'xlsx', listSheets: true }), 'sheet-list')
})

test('getOrCompute parses once and dedupes concurrent callers', async () => {
  const cache = new ParseCache(4)
  let computes = 0
  const slow = async () => {
    computes += 1
    await new Promise((r) => setTimeout(r, 30))
    return 'parsed'
  }
  const [a, b, c] = await Promise.all([
    cache.getOrCompute(key('x', 'v1'), slow),
    cache.getOrCompute(key('x', 'v1'), slow),
    cache.getOrCompute(key('x', 'v1'), slow)
  ])
  assert.equal(computes, 1, '并发同 key 只解析一次')
  assert.deepEqual([a, b, c], ['parsed', 'parsed', 'parsed'])
  // 完成后再次调用走缓存，不再 compute
  const again = await cache.getOrCompute(key('x', 'v1'), slow)
  assert.equal(again, 'parsed')
  assert.equal(computes, 1)
})

test('getOrCompute failure is not cached; next call retries', async () => {
  const cache = new ParseCache(4)
  let tries = 0
  const flaky = async () => {
    tries += 1
    if (tries === 1) throw new Error('boom')
    return 'ok'
  }
  await assert.rejects(() => cache.getOrCompute(key('y', 'v1'), flaky), /boom/)
  const ok = await cache.getOrCompute(key('y', 'v1'), flaky)
  assert.equal(ok, 'ok')
  assert.equal(tries, 2)
})

test('getOrCompute still distinguishes keys', async () => {
  const cache = new ParseCache(4)
  let computes = 0
  const count = async () => {
    computes += 1
    return 'x'
  }
  await Promise.all([
    cache.getOrCompute(key('a', 'v1'), count),
    cache.getOrCompute(key('b', 'v1'), count)
  ])
  assert.equal(computes, 2, '不同 key 各自解析')
})
