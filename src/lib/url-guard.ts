/** Outbound URL guard (SSRF). A URL a browser can supply (AI base URL, a registered model's
 *  endpoint) must not let the server reach private networks or cloud metadata services.
 *
 *  `checkUrlSyntax` is sync and judges the literal host; `assertSafeUrl` also resolves the name
 *  and judges every address it maps to. A resolved check cannot close a DNS-rebinding race
 *  between the check and the connection, so deployments that must be strict should also deny
 *  private egress at the network layer.
 *
 *  Loopback hosts are allowed outside production (local Ollama, local sidecars).
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

type Env = Record<string, string | undefined>

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data'])

/** True for an IPv4 or IPv6 literal that is not a public unicast address. */
export function isNonPublicIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isNonPublicIp(mapped[1])
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    )
  }
  if (isIP(v) === 6) {
    return (
      v === '::' || v === '::1' ||
      /^f[cd]/.test(v) || // unique local fc00::/7
      /^fe[89ab]/.test(v) || // link-local fe80::/10
      /^ff/.test(v) // multicast
    )
  }
  return false
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'))
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/** Judge a URL by its scheme and literal host. */
export function checkUrlSyntax(raw: string, env: Env = process.env): UrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http(s) URLs are allowed' }
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isLoopbackHost(host)) {
    return env.NODE_ENV !== 'production' ? { ok: true, url } : { ok: false, reason: 'localhost is not allowed in production' }
  }
  if (METADATA_HOSTS.has(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'internal and metadata hostnames are not allowed' }
  }
  if (isNonPublicIp(host)) return { ok: false, reason: 'private, loopback and link-local addresses are not allowed' }
  return { ok: true, url }
}

/** `fetch` for a URL a browser chose: every hop, redirects included, passes `assertSafeUrl`,
 *  so a public host cannot bounce the server to an internal address. */
export async function fetchGuarded(raw: string, init: RequestInit = {}, maxRedirects = 4): Promise<Response> {
  let url = raw
  let req: RequestInit = { ...init, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(url)
    const res = await fetch(url, req)
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return res
    if (hop >= maxRedirects) throw new Error('Blocked URL: too many redirects.')
    url = new URL(location, url).toString()
    // 301/302/303 turn a POST into a GET; 307/308 keep method and body.
    if ([301, 302, 303].includes(res.status) && req.method && req.method !== 'GET') req = { ...req, method: 'GET', body: undefined }
  }
}

/** `checkUrlSyntax`, then resolve the host and reject if any address is non-public. */
export async function assertSafeUrl(raw: string, env: Env = process.env): Promise<URL> {
  const checked = checkUrlSyntax(raw, env)
  if (!checked.ok) throw new Error(`Blocked URL: ${checked.reason}.`)
  const host = checked.url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) || isLoopbackHost(host.toLowerCase())) return checked.url
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error(`Blocked URL: host "${host}" did not resolve.`)
  }
  if (addrs.some((a) => isNonPublicIp(a.address))) throw new Error(`Blocked URL: "${host}" resolves to a private or link-local address.`)
  return checked.url
}
