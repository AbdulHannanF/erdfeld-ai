/**
 * C2 — User data upload (Tier 2) pure helpers.
 *
 * Validation + tile-URL building for user-uploaded GeoTIFF/COG orthomosaics. Kept
 * pure (no fs, no fetch) so it unit-tests in isolation; the route (`/api/upload`)
 * does the actual storage + wiring.
 *
 * Tier 2 is the only path where sub-meter / species-level questions become honest:
 * the resolution is whatever the user's data actually is, not an assumed 10 m.
 */

/** Allowed GeoTIFF extensions + MIME types. */
const ALLOWED_EXT = ['.tif', '.tiff', '.gtiff', '.cog']
const ALLOWED_MIME = ['image/tiff', 'image/geo+tiff', 'application/octet-stream', '']
/** 500 MB cap — a drone orthomosaic COG is large but bounded. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

export interface UploadValidation {
  ok: boolean
  reason?: string
}

/** Validate an upload's filename, content-type, and size before storing it. Pure. */
export function validateUpload(
  name: string | null | undefined,
  contentType: string | null | undefined,
  sizeBytes: number,
): UploadValidation {
  if (!name || typeof name !== 'string') return { ok: false, reason: 'missing filename' }
  const lower = name.toLowerCase()
  if (!ALLOWED_EXT.some((e) => lower.endsWith(e))) {
    return { ok: false, reason: `unsupported file type — expected a GeoTIFF/COG (${ALLOWED_EXT.join(', ')})` }
  }
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim()
  if (!ALLOWED_MIME.includes(ct)) {
    return { ok: false, reason: `unexpected content-type "${ct}" — expected a GeoTIFF` }
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, reason: 'empty file' }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `file too large (${(sizeBytes / 1e6).toFixed(0)} MB > ${MAX_UPLOAD_BYTES / 1e6} MB cap)` }
  }
  return { ok: true }
}

/** Produce a safe, collision-resistant stored filename from a user filename. Pure. */
export function safeStoredName(name: string, randomSuffix: string = Math.random().toString(36).slice(2, 10)): string {
  const lower = name.toLowerCase()
  const ext = ALLOWED_EXT.find((e) => lower.endsWith(e)) ?? '.tif'
  const base = name
    .slice(0, name.length - ext.length)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 48) || 'upload'
  return `${base}-${randomSuffix}${ext === '.cog' ? '.tif' : ext}`
}

/**
 * Build a TiTiler XYZ tile URL for an uploaded COG. `publicCogUrl` must be reachable
 * by the TiTiler instance (NOT a localhost-only path) — the route derives it from
 * PUBLIC_BASE_URL. `titilerBase` is the resolved TiTiler endpoint. Pure.
 */
export function buildUploadedCogTileUrl(
  titilerBase: string,
  publicCogUrl: string,
  opts?: { rescale?: string; colormap?: string; bidx?: number },
): string {
  const params = new URLSearchParams({ url: publicCogUrl, return_mask: 'true' })
  if (opts?.rescale) params.set('rescale', opts.rescale)
  if (opts?.colormap) params.set('colormap_name', opts.colormap)
  if (opts?.bidx) params.set('bidx', String(opts.bidx))
  return `${titilerBase.replace(/\/+$/, '')}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${params}`
}

/** Whether user uploads are enabled (needs an explicit opt-in — uploads write to disk). */
export function uploadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_UPLOADS === '1' || env.ENABLE_UPLOADS === 'true'
}
