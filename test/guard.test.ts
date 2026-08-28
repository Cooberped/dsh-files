// Network-guard tests: the upload fence accepts loopback by default, and
// `trustedHosts` (bare host matches any port, host:port matches exactly)
// plus host-part-only Origin comparison make public-domain / reverse-tunnel
// deployments work. Regression for github.com/taxueseek/dsh-files#6.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { networkGuard, parseHost } from '../src/guard.ts'

function req(host: string | undefined, origin?: string, secFetchSite?: string, remoteAddress?: string): IncomingMessage {
  const headers: Record<string, string> = {}
  if (host !== undefined) headers.host = host
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  // 明文 socket：TLS 在上游终结时 dsh 进程看到的是 http。
  return { headers, socket: remoteAddress === undefined ? {} : { remoteAddress } } as unknown as IncomingMessage
}

test('loopback hosts pass with the default empty trustedHosts', () => {
  for (const host of [
    '127.0.0.1',
    '127.0.0.1:3080',
    '127.0.0.2',
    '127.255.255.254:3080',
    '127.1',
    'localhost',
    'localhost:3080',
    '[::1]:3080',
    '[::1]',
    '[::ffff:127.0.0.1]:3080',
    '[::ffff:127.255.255.254]'
  ]) {
    assert.equal(networkGuard(req(host)), null, host)
  }
})

test('non-loopback host is rejected without trustedHosts', () => {
  assert.equal(networkGuard(req('dsh.example.com')), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req('192.168.1.10:3080')), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req('[::ffff:192.168.1.10]:3080')), 'forbidden: non-loopback host')
})

test('a forged loopback Host cannot authorize a non-loopback socket peer', () => {
  assert.equal(networkGuard(req('127.0.0.1:3080', undefined, undefined, '192.168.1.10')), 'forbidden: non-loopback peer')
  assert.equal(networkGuard(req('localhost:3080', undefined, undefined, '::ffff:192.168.1.10')), 'forbidden: non-loopback peer')
  assert.equal(networkGuard(req('localhost:3080', undefined, undefined, '::ffff:127.0.0.1')), null)
  // An explicit trusted host is the deliberate reverse-proxy path.
  assert.equal(networkGuard(req('dsh.example.com', 'https://dsh.example.com', 'same-origin', '192.168.1.10'), ['dsh.example.com']), null)
})

test('bare trusted host matches any port', () => {
  const g = ['dsh.example.com']
  assert.equal(networkGuard(req('dsh.example.com:3080'), g), null)
  assert.equal(networkGuard(req('dsh.example.com:443'), g), null)
  assert.equal(networkGuard(req('dsh.example.com'), g), null)
  assert.equal(networkGuard(req('other.example.com:3080'), g), 'forbidden: non-loopback host')
})

test('explicit-port trusted host matches exactly', () => {
  const g = ['dsh.example.com:443']
  assert.equal(networkGuard(req('dsh.example.com:443'), g), null)
  assert.equal(networkGuard(req('dsh.example.com'), g), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req('dsh.example.com:8080'), g), 'forbidden: non-loopback host')
})

test('loopback still passes alongside trustedHosts', () => {
  assert.equal(networkGuard(req('127.0.0.1:3080'), ['dsh.example.com']), null)
})

test('origin is compared by host part only: upstream TLS termination passes', () => {
  // TLS 在 Caddy/frp 终结：socket 明文，浏览器 Origin 是 https。
  const g = ['dsh.example.com']
  assert.equal(networkGuard(req('dsh.example.com', 'https://dsh.example.com'), g), null)
  // URL 会省略 https 的默认 443 端口，因此上游 TLS 终结仍视为同一 authority。
  assert.equal(networkGuard(req('dsh.example.com', 'https://dsh.example.com:443'), g), null)
  // 非默认端口属于不同 authority，不能只凭相同 hostname 放行。
  assert.equal(networkGuard(req('dsh.example.com', 'https://dsh.example.com:8443'), g), 'forbidden: cross-origin')
})

test('loopback + origin with explicit scheme passes', () => {
  assert.equal(networkGuard(req('localhost:3080', 'http://localhost:3080')), null)
  assert.equal(networkGuard(req('127.0.0.1', 'http://127.0.0.1')), null)
})

test('cross-origin host is rejected', () => {
  assert.equal(
    networkGuard(req('dsh.example.com', 'https://attacker.example.com'), ['dsh.example.com']),
    'forbidden: cross-origin'
  )
})

test('malformed origin is rejected', () => {
  assert.equal(networkGuard(req('dsh.example.com', 'not a url'), ['dsh.example.com']), 'forbidden: cross-origin')
})

test('sec-fetch-site guards cross-site requests', () => {
  assert.equal(networkGuard(req('localhost', undefined, 'cross-site')), 'forbidden: cross-site')
  assert.equal(networkGuard(req('localhost', undefined, 'same-origin')), null)
  assert.equal(networkGuard(req('localhost', undefined, 'none')), null)
})

test('missing Host header is malformed', () => {
  assert.equal(networkGuard(req(undefined)), 'forbidden: malformed host')
})

test('parseHost validates config entries at boot', () => {
  assert.notEqual(parseHost('example.com'), null)
  assert.notEqual(parseHost('example.com:443'), null)
  assert.notEqual(parseHost('[::1]:8080'), null)
  assert.equal(parseHost(''), null)
  assert.equal(parseHost('a b'), null)
  assert.equal(parseHost('http://x y'), null)
})
