/**
 * LIVE rendering verification (opt-in: RENDER_LIVE=1). Hits the network — NOT part of
 * the default suite. Exercises the REAL app URL builders against a REAL titiler instance
 * (TITILER_ENDPOINT, default titiler.xyz) and the REAL Sentinel-2 source via STAC.
 *
 *   RENDER_LIVE=1 npx vitest run render-live
 *   RENDER_LIVE=1 TITILER_ENDPOINT=http://localhost:8000 npx vitest run render-live   # self-host path
 */
import { describe, it, expect } from 'vitest'
import { buildNDVITileUrl, buildSpectralIndexTileUrl, TITILER_BASE } from '../titiler'

const LIVE = !!process.env.RENDER_LIVE
const suite = LIVE ? describe : describe.skip

/** WebMercator tile x/y for a lon/lat at zoom z. */
function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y }
}

async function findS2Scene(bbox: number[]): Promise<any> {
  const res = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: '2025-01-01T00:00:00Z/2026-06-03T23:59:59Z',
      query: { 'eo:cloud_cover': { lt: 12 } },
      limit: 1,
      sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
    }),
  })
  expect(res.ok, `STAC search HTTP ${res.status}`).toBe(true)
  const fc = await res.json()
  return fc.features?.[0]
}

async function fetchTile(template: string, lon: number, lat: number, z: number) {
  const { x, y } = lonLatToTile(lon, lat, z)
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  const res = await fetch(url)
  const buf = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0)
  return { url, status: res.status, type: res.headers.get('content-type') || '', bytes: buf.byteLength }
}

suite('LIVE rendering pipeline (RENDER_LIVE=1)', () => {
  it(`uses TITILER_BASE = ${TITILER_BASE}`, () => {
     
    console.log('   → TITILER_BASE in use:', TITILER_BASE)
    expect(TITILER_BASE).toMatch(/^https?:\/\//)
  })

  it('STAC → buildNDVITileUrl → titiler renders a real PNG tile', async () => {
    const bbox = [36.78, -1.32, 36.86, -1.24] // central Nairobi
    const item = await findS2Scene(bbox)
    expect(item, 'no Sentinel-2 scene found').toBeTruthy()

    const template = buildNDVITileUrl(item)
    expect(template, 'buildNDVITileUrl returned null').toBeTruthy()
    expect(template!).toContain('/stac/tiles/')
    expect(template!.startsWith(TITILER_BASE)).toBe(true)

    const lon = (item.bbox[0] + item.bbox[2]) / 2
    const lat = (item.bbox[1] + item.bbox[3]) / 2
    const r = await fetchTile(template!, lon, lat, 11)
     
    console.log(`   → NDVI tile: HTTP ${r.status} ${r.type} ${r.bytes}B  scene=${item.id}`)
    expect(r.status, `tile HTTP ${r.status} @ ${r.url}`).toBe(200)
    expect(r.type).toContain('png')
    expect(r.bytes).toBeGreaterThan(500)
  }, 90000)

  it('STAC → buildSpectralIndexTileUrl(NDWI) → titiler renders a real PNG tile', async () => {
    const bbox = [36.78, -1.32, 36.86, -1.24]
    const item = await findS2Scene(bbox)
    expect(item).toBeTruthy()

    const template = buildSpectralIndexTileUrl(item, 'NDWI')
    expect(template, 'buildSpectralIndexTileUrl returned null').toBeTruthy()
    expect(template!.startsWith(TITILER_BASE)).toBe(true)

    const lon = (item.bbox[0] + item.bbox[2]) / 2
    const lat = (item.bbox[1] + item.bbox[3]) / 2
    const r = await fetchTile(template!, lon, lat, 11)
     
    console.log(`   → NDWI tile: HTTP ${r.status} ${r.type} ${r.bytes}B`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('png')
    expect(r.bytes).toBeGreaterThan(500)
  }, 90000)
})
