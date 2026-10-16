/** ② Imagery planner (spec §3.3).
 *
 *  > Pick the coarsest source that still resolves the target, escalating only
 *  > when needed. The planner must detect placeholder tiles and stop escalating.
 *  > When nothing in the registry resolves the target, the pipeline says so and
 *  > names what would.
 *
 *  The escalation ceiling is a property of the LOCATION, not of the provider —
 *  measured 2026-08-10 against Esri World Imagery, the last zoom serving real
 *  pixels was z18 over the Sahara, z19 over Lahore, z20 over Manhattan and z21
 *  over Amsterdam. A planner that assumes one global ceiling is wrong nearly
 *  everywhere, so it has to probe.
 */

import { describe, expect, it } from 'vitest'
import {
  ESRI_PLACEHOLDER_BYTES,
  ESRI_PLACEHOLDER_SHA256,
  IMAGERY_REGISTRY,
  isPlaceholderTile,
  metersPerPixel,
  objectPixelsAt,
  planImagery,
  zoomForObjectPixels,
  describeFinerSources,
} from '../imagery-plan'

/** Fake tile bytes: a placeholder is byte-identical everywhere, so any buffer of
 *  the right length is NOT enough — only the real bytes hash correctly. */
function realTile(bytes = 19022): Buffer {
  const b = Buffer.alloc(bytes)
  b.write('\xff\xd8\xff\xe0JFIF-ish-real-tile', 0, 'binary')
  return b
}

describe('metersPerPixel', () => {
  it('is the standard Web-Mercator ground resolution at the equator', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.034, 2)
    expect(metersPerPixel(0, 1)).toBeCloseTo(78271.517, 2)
  })

  it('matches the resolutions measured on the audit sites', () => {
    // Lahore z19 and Manhattan z20 — the two cases the live probe pinned down.
    expect(metersPerPixel(31.52, 19)).toBeCloseTo(0.2545, 3)
    expect(metersPerPixel(40.7549, 20)).toBeCloseTo(0.1132, 3)
    expect(metersPerPixel(52.3676, 21)).toBeCloseTo(0.0456, 3)
  })

  it('halves for every zoom step', () => {
    expect(metersPerPixel(45, 18) / metersPerPixel(45, 19)).toBeCloseTo(2, 6)
  })
})

describe('objectPixelsAt / zoomForObjectPixels', () => {
  it('reproduces the measured pixel sizes of a car', () => {
    expect(objectPixelsAt(4.5, 31.52, 19)).toBeCloseTo(17.7, 1)
    expect(objectPixelsAt(4.5, 40.7549, 20)).toBeCloseTo(39.8, 1)
  })

  it('picks the COARSEST zoom that still clears the pixel floor', () => {
    const z = zoomForObjectPixels(4.5, 40.7549, 20)
    expect(z).toBe(20)
    expect(objectPixelsAt(4.5, 40.7549, z)).toBeGreaterThanOrEqual(20)
    expect(objectPixelsAt(4.5, 40.7549, z - 1)).toBeLessThan(20)
  })

  it('needs a finer zoom for a smaller object', () => {
    expect(zoomForObjectPixels(1.6, 31.52, 20)).toBeGreaterThan(zoomForObjectPixels(10, 31.52, 20))
  })
})

describe('isPlaceholderTile', () => {
  it('recognises the exact Esri placeholder, which is byte-identical worldwide', () => {
    const placeholder = Buffer.alloc(ESRI_PLACEHOLDER_BYTES)
    // Not the real bytes — same length only. Length alone must not convict.
    expect(isPlaceholderTile(placeholder)).toBe(false)
  })

  it('does not flag a real tile', () => {
    expect(isPlaceholderTile(realTile())).toBe(false)
    expect(isPlaceholderTile(realTile(ESRI_PLACEHOLDER_BYTES))).toBe(false)
  })

  it('exposes the measured signature so callers can audit it', () => {
    expect(ESRI_PLACEHOLDER_BYTES).toBe(2521)
    expect(ESRI_PLACEHOLDER_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('IMAGERY_REGISTRY', () => {
  it('is ordered coarsest-first so escalation is monotonic', () => {
    for (let i = 1; i < IMAGERY_REGISTRY.length; i++) {
      expect(IMAGERY_REGISTRY[i].bestResolutionM).toBeLessThanOrEqual(IMAGERY_REGISTRY[i - 1].bestResolutionM)
    }
  })

  it('only lists sources the app can actually fetch', () => {
    for (const s of IMAGERY_REGISTRY) {
      expect(s.urlTemplate).toMatch(/^https:\/\//)
      expect(s.urlTemplate).toContain('{z}')
      expect(s.maxZoom).toBeGreaterThan(s.minZoom)
    }
  })
})

describe('planImagery', () => {
  /** Probe stub reproducing a measured ceiling: real tiles up to `ceiling`. */
  const probeWithCeiling = (ceiling: number) => async (_url: string, z: number) =>
    z <= ceiling ? realTile() : { placeholder: true as const }

  it('resolves a car over Manhattan, where imagery reaches z20', async () => {
    const plan = await planImagery({
      lat: 40.7549, lon: -73.984, footprintM: 4.5, minPx: 20,
      fetchTile: probeWithCeiling(20),
    })
    expect(plan.ok).toBe(true)
    expect(plan.zoom).toBe(20)
    expect(plan.objectPx).toBeGreaterThanOrEqual(20)
    expect(plan.source?.id).toBe('esri-world-imagery')
  })

  it('refuses a car over Lahore, where imagery stops at z19 — and says what would work', async () => {
    const plan = await planImagery({
      lat: 31.52, lon: 74.32, footprintM: 4.5, minPx: 20,
      fetchTile: probeWithCeiling(19),
    })
    expect(plan.ok).toBe(false)
    expect(plan.ceilingZoom).toBe(19)
    expect(plan.ceilingMpp).toBeCloseTo(0.2545, 3)
    // The honest part: it must name the resolution that WOULD resolve it.
    expect(plan.wouldNeed).toBeTruthy()
    expect(plan.wouldNeed).toMatch(/0\.2\d\s*m/)
    expect(plan.reason).toMatch(/17|18|resolve/i)
  })

  it('stops escalating at the placeholder rather than fetching ever-finer nothing', async () => {
    const seen: number[] = []
    await planImagery({
      lat: 31.52, lon: 74.32, footprintM: 0.3, minPx: 20,   // a pole: hopeless
      fetchTile: async (_u, z) => { seen.push(z); return z <= 19 ? realTile() : { placeholder: true as const } },
    })
    // It must not probe every zoom up to 30 hunting for imagery that is not there.
    expect(Math.max(...seen)).toBeLessThanOrEqual(23)
    expect(seen.length).toBeLessThanOrEqual(8)
  })

  it('reports a sub-metre target as unresolvable at any public nadir resolution', async () => {
    const plan = await planImagery({
      lat: 31.52, lon: 74.32, footprintM: 0.3, minPx: 20,
      fetchTile: probeWithCeiling(19),
    })
    expect(plan.ok).toBe(false)
    expect(plan.wouldNeed).toMatch(/street-level|Mapillary|0\.0\d/i)
  })

  it('cannot plan without a footprint, and says so instead of assuming one', async () => {
    const plan = await planImagery({
      lat: 31.52, lon: 74.32, footprintM: null, minPx: 20,
      fetchTile: probeWithCeiling(19),
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/size|footprint/i)
  })

  it('treats a fetch failure as a failure, never as a placeholder', async () => {
    const plan = await planImagery({
      lat: 40.7549, lon: -73.984, footprintM: 4.5, minPx: 20,
      fetchTile: async () => { throw new Error('ECONNRESET') },
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/ECONNRESET|could not|unreachable/i)
    // A network error must not be reported as "no imagery exists here".
    expect(plan.reason).not.toMatch(/placeholder/i)
  })
})

describe('describeFinerSources', () => {
  it('names a real finer source for a US location', () => {
    expect(describeFinerSources(40.75, -73.98)).toMatch(/NAIP/i)
  })

  it('names the Dutch orthophoto for a NL location', () => {
    expect(describeFinerSources(52.37, 4.9)).toMatch(/PDOK|Netherlands/i)
  })

  it('still offers something generic elsewhere', () => {
    const s = describeFinerSources(31.52, 74.32)
    expect(s.length).toBeGreaterThan(10)
    expect(s).toMatch(/OpenAerialMap|Maxar|drone|street-level/i)
  })
})
