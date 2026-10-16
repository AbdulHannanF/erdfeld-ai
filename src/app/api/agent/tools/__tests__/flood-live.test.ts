/** LIVE flood mapping (opt-in: FLOOD_LIVE=1, needs NODE_USE_ENV_PROXY=1 behind a proxy). Hits Planetary
 *  Computer STAC + titiler.xyz + Overture S3 — NOT part of the default suite.
 *
 *    FLOOD_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run flood-live
 *
 *  Optional: FLOOD_BBOX=minLng,minLat,maxLng,maxLat  FLOOD_ARGS='{"start":"2025-06-15","end":"2025-10-15"}'
 *            FLOOD_EXPORT=/path/flood.json  (writes the full result for demos)
 *  Defaults to the 2025 Ravi flood at Lahore (a scan, so the dates come from the data). */
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { executeTool } from '../index'

const LIVE = !!process.env.FLOOD_LIVE
const suite = LIVE ? describe : describe.skip

const MAX_EXPORT_BUILDINGS = 6000

suite('map_flood (live)', () => {
  it('scans the window, finds a peak and maps the flood', async () => {
    const bbox = (process.env.FLOOD_BBOX ?? '74.22,31.56,74.34,31.66').split(',').map(Number)
    const args = JSON.parse(process.env.FLOOD_ARGS ?? '{"start":"2025-06-15","end":"2025-10-15"}')
    const aoi = { type: 'Polygon', coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] }
    const r = await executeTool('map_flood', aoi, args)
    console.log(r.summary)
    console.log(JSON.stringify(r.stats, null, 1))

    const sd = r.stats!
    expect(typeof sd.flood_area_km2).toBe('number')
    expect(sd.after_date > sd.before_date).toBe(true)
    const layers = [r.layers[0], ...(r.layers ?? [])].filter(Boolean)
    expect(layers.length).toBeGreaterThanOrEqual(2)

    const out = process.env.FLOOD_EXPORT
    if (out) {
      const byName = (re: RegExp) => layers.find((l) => re.test(l!.name))
      const flood = byName(/Flood extent/)
      const bld = byName(/Flooded buildings/)
      const feats: any[] = bld?.geojson?.features ?? []
      const step = Math.max(1, Math.ceil(feats.length / MAX_EXPORT_BUILDINGS))
      const centroid = (g: any) => {
        const ring = g.type === 'Point' ? [g.coordinates] : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]
        const n = ring.length - (g.type === 'Point' ? 0 : 1) || 1
        const c = ring.slice(0, n).reduce((s: number[], p: number[]) => [s[0] + p[0], s[1] + p[1]], [0, 0])
        return [Math.round((c[0] / n) * 1e5) / 1e5, Math.round((c[1] / n) * 1e5) / 1e5]
      }
      const sampled = feats.filter((_, i) => i % step === 0).slice(0, MAX_EXPORT_BUILDINGS)
      writeFileSync(out, JSON.stringify({
        aoi_bbox: bbox,
        args,
        summary: r.summary,
        summary_data: r.stats,
        series: r.charts?.[0]?.spec?.data?.values ?? [],
        layers: layers.filter((l) => l!.type === 'raster').map((l) => ({ name: l!.name, tileUrl: l!.tileUrl, date: l!.provenance?.date, raster: l!.raster, visibleByDefault: l!.defaultVisible !== false })),
        flood_polygons: flood?.geojson ?? { type: 'FeatureCollection', features: [] },
        affected_buildings: {
          note: `centroids of affected buildings; ${sampled.length} of ${feats.length} shown (cap ${MAX_EXPORT_BUILDINGS}); the full count is summary_data.affected_buildings`,
          geojson: { type: 'FeatureCollection', features: sampled.map((f) => ({ type: 'Feature', properties: { id: f.properties.id }, geometry: { type: 'Point', coordinates: centroid(f.geometry) } })) },
        },
        chart: r.charts?.[0]?.spec ?? null,
      }))
    }
  }, 900_000)
})
