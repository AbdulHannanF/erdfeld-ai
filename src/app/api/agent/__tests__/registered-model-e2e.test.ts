/**
 * PHASE 1 GATE: "a model added from Settings runs end to end."
 *
 * This drives the real request path — a model spec exactly as the Settings field
 * would produce it, through `executeTool`, through the registry, through the
 * provider adapter, out to georeferenced detections on a map layer. The only
 * thing stubbed is the network: a local HTTP server stands in for the user's own
 * inference endpoint, and Esri tile fetches are intercepted.
 *
 * Nothing about the registry, the adapter, the tiling, the georeferencing or the
 * provenance is mocked — a regression in any of them fails this test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import sharp from 'sharp'
import { executeTool } from '../tools'
import { buildModelRegistry } from '../lib/inference/model-registry'
import { _resetCache } from '../lib/cache'

/** ~1.1 km² AOI over Lahore. */
const AOI = {
  type: 'Polygon',
  coordinates: [[[74.320, 31.520], [74.330, 31.520], [74.330, 31.528], [74.320, 31.528], [74.320, 31.520]]],
}

let server: Server
let endpoint: string
let requestCount = 0
let lastBody: any = null

beforeAll(async () => {
  process.env.GEOAGENT_ENABLE_CV = '1' // the detectors are parked behind this flag
  // Stand-in for "my own GPU box" — the custom-http contract.
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      requestCount++
      try { lastBody = JSON.parse(raw) } catch { lastBody = null }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Two boxes per tile, in 256-px tile pixel space.
      res.end(JSON.stringify({
        predictions: [
          { x: 64, y: 64, width: 12, height: 6, class: 'car', confidence: 0.88 },
          { x: 192, y: 200, width: 10, height: 5, class: 'car', confidence: 0.71 },
        ],
      }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/detect`
})

afterAll(() => { server?.close(); delete process.env.GEOAGENT_ENABLE_CV })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); requestCount = 0; lastBody = null })

/** A 256×256 PNG so the tile fetch returns something decodable. */
async function fakeTile(): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .png().toBuffer()
}

/** Let the stub endpoint through; serve every Esri tile from a generated PNG. */
async function stubTiles() {
  const tile = await fakeTile()
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const u = String(url)
    if (u.includes('127.0.0.1')) return realFetch(url, init)
    if (/arcgisonline|esri/i.test(u)) {
      return new Response(new Uint8Array(tile), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

/** Exactly what a user would paste into the Settings "custom models" field. */
const SETTINGS_JSON = (ref: string) => JSON.stringify([{
  id: 'my_car_detector',
  provider: 'custom-http',
  ref,
  task: 'detect',
  classes: ['car'],
  input_size: 640,
  profile: 'tiny',
  license: 'proprietary (my own weights)',
  resolution_m: 0.3,
  resolution_limit: 'Cars need <=0.5 m imagery; at 0.3 m Esri this is within scope.',
}])

describe('PHASE 1 GATE — a model added from Settings runs end to end', () => {
  it('registers from the Settings JSON exactly as typed', () => {
    const reg = buildModelRegistry({ profile: 'tiny', userSpecs: SETTINGS_JSON(endpoint) })
    expect(reg.errors).toEqual([])
    const m = reg.models.get('my_car_detector')
    expect(m).toBeDefined()
    expect(m!.provider).toBe('custom-http')
    expect(m!.classes).toEqual(['car'])
    expect(m!.inputSize).toBe(640)
    expect(reg.sourceOf('my_car_detector')).toBe('settings')
  })

  it('runs through run_cv_detector and returns georeferenced detections', async () => {
    _resetCache()
    await stubTiles()
    const models = buildModelRegistry({ profile: 'tiny', userSpecs: SETTINGS_JSON(endpoint) })

    const r = await executeTool(
      'run_cv_detector', AOI, { model: 'my_car_detector' }, undefined, undefined, models,
    )

    console.log(`gate → ${r.summary.slice(0, 220).replace(/\s+/g, ' ')}`)

    // The user's endpoint was actually called, with an image.
    expect(requestCount, 'the registered endpoint was never called').toBeGreaterThan(0)
    expect(lastBody?.model).toBe('my_car_detector')
    expect(typeof lastBody?.image?.value).toBe('string')
    expect(lastBody.image.value.length).toBeGreaterThan(100)

    // Detections came back as real map geometry.
    const layer: any = r.layers[0] ?? (r as any).layers?.[0]
    expect(layer, 'no layer returned').toBeTruthy()
    const features = layer.geojson?.features ?? []
    expect(features.length).toBeGreaterThan(0)

    // Georeferenced inside the AOI bbox — not tile pixels leaking through.
    for (const f of features.slice(0, 5)) {
      const [lng, lat] = f.geometry.type === 'Point'
        ? f.geometry.coordinates
        : f.geometry.coordinates[0][0]
      expect(lng).toBeGreaterThan(74.31)
      expect(lng).toBeLessThan(74.34)
      expect(lat).toBeGreaterThan(31.51)
      expect(lat).toBeLessThan(31.54)
    }

    // Provenance names the model and the provider, and never claims a source it did not use.
    const prov = JSON.stringify(layer.provenance ?? {})
    expect(prov).toMatch(/my_car_detector|custom-http/)
    expect(prov).not.toMatch(/roboflow/i)
  }, 120_000)

  it('refuses honestly when the registered endpoint fails — no phantom "0 detections"', async () => {
    _resetCache()
    const tile = await fakeTile()
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('127.0.0.1')) return new Response('gpu on fire', { status: 503 })
      if (/arcgisonline|esri/i.test(u)) {
        return new Response(new Uint8Array(tile), { status: 200, headers: { 'Content-Type': 'image/png' } })
      }
      return new Response('{}', { status: 200 })
    }))
    const models = buildModelRegistry({ profile: 'tiny', userSpecs: SETTINGS_JSON(endpoint) })

    const r = await executeTool(
      'run_cv_detector', AOI, { model: 'my_car_detector' }, undefined, undefined, models,
    )
    console.log(`gate(fail) → ${r.summary.slice(0, 200).replace(/\s+/g, ' ')}`)

    // A 503 must not read as "found nothing".
    expect(r.summary).toMatch(/503|failed|unreachable/i)
    expect(r.summary).not.toMatch(/found \*\*0 detections\*\*/)
    expect(r.layers).toHaveLength(0)
  }, 120_000)

  it('tells the user why a model registered above the box profile is unavailable', async () => {
    const models = buildModelRegistry({
      profile: 'tiny',
      userSpecs: JSON.stringify([{ id: 'big_model', provider: 'custom-http', ref: endpoint, task: 'detect', profile: 'large' }]),
    })
    const r = await executeTool(
      'run_cv_detector', AOI, { model: 'big_model' }, undefined, undefined, models,
    )
    console.log(`gate(profile) → ${r.summary.slice(0, 200).replace(/\s+/g, ' ')}`)
    expect(r.summary).toMatch(/big_model/)
    expect(r.summary).toMatch(/profile|MODEL_PROFILE/i)
  }, 60_000)
})
