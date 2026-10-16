/**
 * Unit tests for C2 — Tier 2 upload pure helpers.
 */

import { describe, it, expect } from 'vitest'
import {
  validateUpload,
  safeStoredName,
  buildUploadedCogTileUrl,
  uploadsEnabled,
  MAX_UPLOAD_BYTES,
} from '../upload'

describe('validateUpload', () => {
  it('accepts a .tif within the size cap', () => {
    expect(validateUpload('field.tif', 'image/tiff', 1_000_000)).toEqual({ ok: true })
  })
  it('accepts .tiff / .cog extensions', () => {
    expect(validateUpload('a.tiff', 'image/tiff', 100).ok).toBe(true)
    expect(validateUpload('a.cog', 'application/octet-stream', 100).ok).toBe(true)
  })
  it('accepts octet-stream + empty content-type (browsers vary)', () => {
    expect(validateUpload('a.tif', '', 100).ok).toBe(true)
    expect(validateUpload('a.tif', 'application/octet-stream', 100).ok).toBe(true)
  })
  it('rejects a non-GeoTIFF extension', () => {
    const r = validateUpload('photo.png', 'image/png', 100)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('unsupported file type')
  })
  it('rejects a wrong content-type', () => {
    const r = validateUpload('a.tif', 'image/png', 100)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('content-type')
  })
  it('rejects an empty file', () => {
    expect(validateUpload('a.tif', 'image/tiff', 0).ok).toBe(false)
  })
  it('rejects a file over the cap', () => {
    const r = validateUpload('a.tif', 'image/tiff', MAX_UPLOAD_BYTES + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('too large')
  })
  it('rejects a missing filename', () => {
    expect(validateUpload(null, 'image/tiff', 100).ok).toBe(false)
  })
})

describe('safeStoredName', () => {
  it('sanitizes unsafe characters + appends a suffix + keeps extension', () => {
    expect(safeStoredName('My Field 2024!.tif', 'abc123')).toBe('My_Field_2024_-abc123.tif')
  })
  it('normalizes .cog → .tif', () => {
    expect(safeStoredName('scan.cog', 'x')).toBe('scan-x.tif')
  })
  it('falls back to "upload" when the base is empty', () => {
    expect(safeStoredName('.tif', 'x')).toBe('upload-x.tif')
  })
  it('truncates very long names', () => {
    const name = 'a'.repeat(200) + '.tif'
    const stored = safeStoredName(name, 'x')
    expect(stored.length).toBeLessThan(70)
    expect(stored.endsWith('-x.tif')).toBe(true)
  })
})

describe('buildUploadedCogTileUrl', () => {
  it('builds an XYZ tile template against the TiTiler base + public COG url', () => {
    const url = buildUploadedCogTileUrl('http://titiler:8000', 'http://app:3000/uploads/x.tif')
    expect(url).toContain('http://titiler:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png')
    expect(url).toContain('url=http%3A%2F%2Fapp%3A3000%2Fuploads%2Fx.tif')
    expect(url).toContain('return_mask=true')
  })
  it('trims a trailing slash on the titiler base', () => {
    const url = buildUploadedCogTileUrl('http://titiler:8000/', 'http://app/x.tif')
    expect(url).toContain('http://titiler:8000/cog/tiles/')
    expect(url).not.toContain('8000//cog')
  })
  it('applies optional rescale/colormap/bidx', () => {
    const url = buildUploadedCogTileUrl('http://t', 'http://a/x.tif', { rescale: '0,255', colormap: 'viridis', bidx: 1 })
    expect(url).toContain('rescale=0%2C255')
    expect(url).toContain('colormap_name=viridis')
    expect(url).toContain('bidx=1')
  })
})

describe('uploadsEnabled', () => {
  it('off by default', () => {
    expect(uploadsEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })
  it('on with ENABLE_UPLOADS=1 or true', () => {
    expect(uploadsEnabled({ ENABLE_UPLOADS: '1' } as any)).toBe(true)
    expect(uploadsEnabled({ ENABLE_UPLOADS: 'true' } as any)).toBe(true)
  })
})
