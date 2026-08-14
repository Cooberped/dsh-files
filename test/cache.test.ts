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
