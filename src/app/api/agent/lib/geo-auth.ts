/** Credentials for calling the geo service when it runs on Cloud Run with IAM (no public access).
 *
 *  Set `GEO_SERVICE_AUDIENCE` to the geo service's URL (the Cloud Run service URL). Each call then
 *  carries `Authorization: Bearer <Google ID token>`, fetched from the metadata server (the web
 *  service's own service account, which needs roles/run.invoker on the geo service) and cached
 *  until shortly before it expires. With no audience configured (local dev, docker-compose) no
 *  header is added, so nothing changes there.
 *
 *  `geoAuthHeaders` returns `null` when an audience is set but a token could not be had: callers
 *  report that as a failed fetch, never send an unauthenticated request and read the 403 as data.
 */

const METADATA_IDENTITY = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
/** Renew this long before the token's own expiry. */
const SKEW_MS = 120_000

const cache = new Map<string, { token: string; expMs: number }>()
const inflight = new Map<string, Promise<string | null>>()

export function geoAuthAudience(): string | null {
  return process.env.GEO_SERVICE_AUDIENCE?.trim().replace(/\/+$/, '') || null
}

/** `exp` (ms since epoch) from a JWT payload; null when it cannot be read. */
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

async function fetchToken(audience: string): Promise<string | null> {
  try {
    const res = await fetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const token = (await res.text()).trim()
    const expMs = jwtExpiryMs(token)
    if (!token || expMs === null) return null
    cache.set(audience, { token, expMs })
    return token
  } catch {
    return null
  }
}

async function idToken(audience: string): Promise<string | null> {
  const hit = cache.get(audience)
  if (hit && hit.expMs - SKEW_MS > Date.now()) return hit.token
  let p = inflight.get(audience)
  if (!p) {
    p = fetchToken(audience).finally(() => inflight.delete(audience))
    inflight.set(audience, p)
  }
  return p
}

/** Headers to add to a geo-service request: `{}` when auth is not configured, `null` when it is
 *  but no token could be obtained. */
export async function geoAuthHeaders(): Promise<Record<string, string> | null> {
  const audience = geoAuthAudience()
  if (!audience) return {}
  const token = await idToken(audience)
  return token ? { authorization: `Bearer ${token}` } : null
}

/** Test seam: forget cached tokens. */
export function resetGeoAuthCache(): void {
  cache.clear()
  inflight.clear()
}
