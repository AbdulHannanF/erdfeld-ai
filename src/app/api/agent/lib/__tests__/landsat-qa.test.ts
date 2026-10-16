/**
 * Landsat Collection-2 QA_PIXEL cloud screening (ISS-101, thermal arm).
 *
 * WHY: `fetch_thermal` had no cloud masking. Measured live 2026-08-10 on the audit
 * AOI (Lahore, 16.9 km²), the tool picked the newest Landsat scene under the
 * scene-wide 40% cloud gate (2026-08-02, 27.5%) and reported a mean land surface
 * temperature of **−3.2 °C**. QA_PIXEL says that AOI was **0% clear** — every pixel
 * cloud, cirrus or shadow. Cloud tops are cold, so the contamination pulls LST down
 * instead of up: the clear scene eight days earlier (2026-06-23, 0.3% cloud) reads
 * **+44.3 °C** with a 2.5 K standard deviation. A 47-degree error that inverts the
 * meaning of any heat-island answer.
 *
 * Every QA value in these tests was read off the real COGs (titiler
 * /cog/feature.npy over the audit AOI) — none are invented.
 */

import { describe, expect, it } from 'vitest'
import {
  LANDSAT_QA,
  landsatQaIsClear,
  landsatQaLabel,
  landsatQaClarity,
} from '../cloud'

// ── Values tallied from LC09_L2SP_149038_20260802 (27.5% scene cloud) ─────────
const CLOUD_AND_CIRRUS = 55052 // 0b1101011100001100 — bits 2 (cirrus) + 3 (cloud), n=5879
const CLOUD = 22280            // 0b0101011100001000 — bit 3 (cloud),              n=3336
const DILATED_CIRRUS_SHADOW = 56598 // bits 1 + 2 + 4,                             n=1

// ── Values tallied from LC08_L2SP_149038_20260623 (0.3% scene cloud) ─────────
const CLEAR_LAND = 21824  // 0b0101010101000000 — bit 6 (clear),        n=8978
const CLOUD_SHADOW = 23888 // 0b0101110101010000 — bit 4 (cloud shadow), n=119
const DILATED_CLOUD = 21762 // 0b0101010100000010 — bit 1,               n=44

describe('landsatQaIsClear (real QA_PIXEL values)', () => {
  it('accepts clear land', () => {
    expect(landsatQaIsClear(CLEAR_LAND)).toBe(true)
  })

  it('rejects every contaminated class present in the clouded scene', () => {
    expect(landsatQaIsClear(CLOUD_AND_CIRRUS)).toBe(false)
    expect(landsatQaIsClear(CLOUD)).toBe(false)
    expect(landsatQaIsClear(DILATED_CIRRUS_SHADOW)).toBe(false)
    expect(landsatQaIsClear(CLOUD_SHADOW)).toBe(false)
    expect(landsatQaIsClear(DILATED_CLOUD)).toBe(false)
  })

  it('rejects fill pixels (bit 0) — LST 0 DN would decode to −124 °C', () => {
    expect(landsatQaIsClear(LANDSAT_QA.FILL)).toBe(false)
    expect(landsatQaIsClear(0)).toBe(false)
  })

  it('accepts water and snow — real surfaces, not contamination', () => {
    expect(landsatQaIsClear(LANDSAT_QA.CLEAR | LANDSAT_QA.WATER)).toBe(true)
    expect(landsatQaIsClear(LANDSAT_QA.SNOW)).toBe(true)
  })
})

describe('landsatQaLabel', () => {
  it('names the dominant contaminant, cloud before its dilation', () => {
    expect(landsatQaLabel(CLOUD_AND_CIRRUS)).toBe('cloud')
    expect(landsatQaLabel(CLOUD_SHADOW)).toBe('cloud shadow')
    expect(landsatQaLabel(DILATED_CLOUD)).toBe('dilated cloud')
    expect(landsatQaLabel(CLEAR_LAND)).toBe('clear')
    expect(landsatQaLabel(0)).toBe('no data')
  })
})

describe('landsatQaClarity (pure — scores a decoded QA grid)', () => {
  /** Build a grid the way fetchCogFeatureGrid returns one. */
  function grid(values: number[], mask?: number[]) {
    const n = values.length
    return {
      values: Float64Array.from(values),
      mask: Float64Array.from(mask ?? new Array(n).fill(255)),
      width: n,
      height: 1,
      bands: 2,
      raw: Float64Array.from(values),
    }
  }

  it('scores the 2026-08-02 scene as 0% clear', () => {
    // The real mix: 5879 cloud+cirrus, 3336 cloud, 1 dilated/cirrus/shadow.
    const c = landsatQaClarity(grid([
      ...Array(10).fill(CLOUD_AND_CIRRUS),
      ...Array(6).fill(CLOUD),
    ]))
    expect(c!.clearPct).toBe(0)
    expect(c!.cloudPct).toBe(100)
    expect(c!.kind).toBe('landsat-qa')
  })

  it('scores the 2026-06-23 scene as ~97% clear', () => {
    // 8978 clear : 119 shadow : 74 cloud : 45 dilated ≈ 97.4% clear
    const c = landsatQaClarity(grid([
      ...Array(974).fill(CLEAR_LAND),
      ...Array(13).fill(CLOUD_SHADOW),
      ...Array(8).fill(CLOUD),
      ...Array(5).fill(DILATED_CLOUD),
    ]))
    expect(c!.clearPct).toBeCloseTo(97.4, 0)
    expect(c!.clearPx).toBe(974)
  })

  it('excludes out-of-polygon pixels via the validity mask', () => {
    const c = landsatQaClarity(grid(
      [CLEAR_LAND, CLEAR_LAND, CLOUD, CLOUD],
      [255, 255, 0, 0],
    ))
    expect(c!.totalPx).toBe(2)
    expect(c!.clearPct).toBe(100)
  })

  it('returns null when the polygon contains no valid pixels', () => {
    expect(landsatQaClarity(grid([CLEAR_LAND, CLOUD], [0, 0]))).toBeNull()
    expect(landsatQaClarity(grid([0, 0]))).toBeNull()
  })

  it('reports a per-class breakdown for honest messaging', () => {
    const c = landsatQaClarity(grid([CLEAR_LAND, CLEAR_LAND, CLEAR_LAND, CLOUD]))
    expect(c!.breakdown[0]).toEqual({ label: 'clear', pct: 75 })
    expect(c!.breakdown[1]).toEqual({ label: 'cloud', pct: 25 })
  })
})
