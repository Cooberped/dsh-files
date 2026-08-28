// Shared HTTP network guards for the dsh-files upload surface. Mirrors the
// official dsh-files-button contract: loopback-only host by default, plus
// same-origin and same-site checks. The upload endpoint runs these before
// touching any session or path.
//
// Deployments behind a public domain / reverse tunnel (Caddy, frp) serve the
// GUI through `dsh web --trusted-host`, but this fence only sees the socket
// it owns: the official /api fence accepts those hosts while a hardcoded
// loopback check would reject every upload. `trustedHosts` reuses the same
// semantics — bare host matches any port, `host:port` matches exactly — and
// the Origin check compares the host part only, so TLS terminating upstream
// (plain HTTP socket, https browser Origin) still passes.

import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1'])

/** Split a raw Host/Origin into host (with port), hostname and port; null for malformed input. */
export function parseHost(raw: string): { host: string; hostname: string; port: string | null } | null {
  const input = raw.trim()
  if (input === '') return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`)
    return { host: url.host, hostname: url.hostname, port: url.port || null }
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true
  // RFC 1122 reserves the complete 127/8 block for IPv4 loopback. WHATWG URL
  // canonicalizes shorthand/numeric forms before this point.
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true
  // WHATWG URL canonicalizes IPv4-mapped IPv6 to ::ffff:7fXX:XXXX. Accept
  // exactly the mapped 127/8 range, not arbitrary mapped private addresses.
  // socket.remoteAddress may retain the dotted form instead of going through
  // WHATWG canonicalization.
  const dottedMapped = /^::ffff:(127(?:\.\d{1,3}){3})$/.exec(normalized)
  if (dottedMapped !== null) return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
  return mapped !== null && (Number.parseInt(mapped[1], 16) >>> 8) === 127
}

/**
 * A configured trusted host entry accepts the request Host:
 * - bare `host` matches any port,
 * - `host:port` matches exactly (mirrors the official isTrustedAuthority semantics).
 */
function matchesTrusted(parsed: { host: string; hostname: string; port: string | null }, trustedHosts: string[]): boolean {
  if (trustedHosts.length === 0) return false
  return trustedHosts.some((entry) => {
    const parsedEntry = parseHost(entry)
    if (parsedEntry === null) return false
    if (parsedEntry.port !== null) return parsed.host === parsedEntry.host
    return parsed.hostname === parsedEntry.hostname
  })
}

/**
 * Reject requests that are not loopback (or a configured trusted host),
 * same-origin and same-site. Returns a human-readable reason, or null when
 * the request passes.
 */
export function networkGuard(req: IncomingMessage, trustedHosts: string[] = []): string | null {
  const rawHost = String(req.headers?.host ?? '')
  const parsedHost = parseHost(rawHost)
  if (parsedHost === null) return 'forbidden: malformed host'
  const loopbackHost = isLoopbackHostname(parsedHost.hostname)
  const trustedHost = matchesTrusted(parsedHost, trustedHosts)
  if (!loopbackHost && !trustedHost) {
    return 'forbidden: non-loopback host'
  }
  // Host is client-controlled. On a real node:http socket, require the peer to
  // be loopback too when relying on the implicit loopback trust path; otherwise
  // a remote client bound through 0.0.0.0 could simply forge Host: 127.0.0.1.
  // IPC/test carriers may not expose remoteAddress, so absence keeps the
  // official host-only compatibility path. Explicit trustedHosts remain the
  // opt-in route for a deployment-controlled reverse proxy or tunnel; this
  // host allowlist is not itself client authentication.
  const remoteAddress = req.socket?.remoteAddress
  if (loopbackHost && !trustedHost && remoteAddress !== undefined && !isLoopbackHostname(remoteAddress)) {
    return 'forbidden: non-loopback peer'
  }
  const origin = req.headers?.origin
  if (origin !== undefined) {
    const parsedOrigin = parseHost(origin)
    // Origin 只比较 host 部分：TLS 在上游终结时 socket 是明文 http 而浏览器
    // Origin 是 https，scheme 参与比较会误杀同一部署（与官方栅栏一致）。
    if (parsedOrigin === null || parsedOrigin.hostname !== parsedHost.hostname) {
      return 'forbidden: cross-origin'
    }
  }
  const secFetchSite = req.headers?.['sec-fetch-site']
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return 'forbidden: cross-site'
  }
  return null
}

/** Write a JSON error response. */
export function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error }))
}
