/**
 * C2 — Tier 2 user data upload: POST a GeoTIFF/COG → stored → served as tiles by the
 * self-hosted TiTiler → analyzable like any other layer (this is where sub-meter /
 * species-level questions become honest).
 *
 * Honest degrade: uploads write to disk + need a TiTiler that can read the public URL,
 * so the route is OFF unless ENABLE_UPLOADS=1. When off (or misconfigured) it returns
 * an actionable 503 — never a fabricated layer.
 *
 * Env:
 *   ENABLE_UPLOADS=1            — opt in (required)
 *   UPLOAD_DIR=./public/uploads — where COGs are written (default; served at /uploads)
 *   PUBLIC_BASE_URL=http://app:3000 — base URL TiTiler uses to fetch the stored COG
 *   TITILER_ENDPOINT           — the TiTiler that renders the tiles (Phase A)
 */

import { NextRequest } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { UploadFileMetaSchema, UploadFormSchema, invalidRequest, validate } from '@/lib/api-schemas'
import { enforceRateLimit } from '@/lib/rate-limit'
import { getLogger } from '../agent/lib/logger'
import { TITILER_BASE } from '../agent/lib/titiler'
import {
  validateUpload,
  safeStoredName,
  buildUploadedCogTileUrl,
  uploadsEnabled,
  MAX_UPLOAD_BYTES,
} from '@/lib/upload'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const log = getLogger('api/upload')

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function POST(req: NextRequest): Promise<Response> {
  const limited = await enforceRateLimit(req, 'upload')
  if (limited) return limited

  if (!uploadsEnabled()) {
    return json(
      {
        error: 'uploads_disabled',
        message:
          'User data upload (Tier 2) is disabled. To enable: set ENABLE_UPLOADS=1, a self-hosted ' +
          'TITILER_ENDPOINT, and PUBLIC_BASE_URL (the URL TiTiler uses to fetch stored COGs), then restart. ' +
          'The free Tier-0 analysis (Sentinel-2 10 m etc.) needs none of this.',
      },
      503,
    )
  }

  // Refuse an oversized upload before reading it (the multipart envelope adds a little).
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return json({ error: 'payload_too_large', max_bytes: MAX_UPLOAD_BYTES }, 413)
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return invalidRequest([{ path: '', message: 'Expected multipart/form-data with a `file` field.' }])
  }

  const fields = validate(UploadFormSchema, { file: form.get('file') })
  if (!fields.ok) return fields.response
  const file = fields.data.file
  const meta = validate(UploadFileMetaSchema, { name: file.name, size: file.size })
  if (!meta.ok) return meta.response

  const valid = validateUpload(file.name, file.type, file.size)
  if (!valid.ok) {
    return json({ error: 'invalid_upload', message: valid.reason, maxBytes: MAX_UPLOAD_BYTES }, 422)
  }

  const uploadDir = process.env.UPLOAD_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), 'public', 'uploads')
  const storedName = safeStoredName(file.name)
  try {
    await fs.mkdir(uploadDir, { recursive: true })
    const buf = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(path.join(uploadDir, storedName), buf)
  } catch (err: any) {
    log.error({ err: err?.message }, 'upload write failed')
    return json({ error: 'storage_failed', message: `Could not store the upload: ${err?.message ?? 'unknown'}.` }, 500)
  }

  // The COG must be reachable by the TiTiler instance — derive a public URL.
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!publicBase) {
    return json(
      {
        error: 'public_url_unset',
        message:
          'Upload stored, but PUBLIC_BASE_URL is not set, so the tiler cannot fetch it. ' +
          'Set PUBLIC_BASE_URL (e.g. http://app:3000) to the URL TiTiler can reach this app at.',
        storedName,
      },
      503,
    )
  }

  const publicCogUrl = `${publicBase}/uploads/${storedName}`
  const tileUrl = buildUploadedCogTileUrl(TITILER_BASE, publicCogUrl)

  log.info({ storedName, bytes: file.size }, 'upload stored + tiled')
  return json({
    ok: true,
    name: file.name,
    storedName,
    bytes: file.size,
    publicCogUrl,
    tileUrl,
    tier: 'user-upload',
    tierLabel: 'User upload',
    note:
      'Tile rendering requires a TiTiler that can read PUBLIC_BASE_URL. Resolution is your data’s ' +
      'native resolution — sub-meter questions are honest only at the tier your imagery actually supports.',
  })
}
