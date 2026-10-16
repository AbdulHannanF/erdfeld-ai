import { describe, expect, it } from 'vitest'

import { entropy } from '../belief'
import { binCount, getFamily } from '../catalogue'
import { MIN_VOI_BITS, applicability, selectNext, valueOfInformation, whatWouldDecide, type Situation } from '../select'
import { WINDOW } from './fixtures'

const water = getFamily('water')!
const fire = getFamily('fire')!
const uniform = (f: typeof water) => Object.fromEntries(f.hypotheses.map((h) => [h.id, 1 / f.hypotheses.length]))

const OPS: Record<string, { available: boolean; typicalSeconds: number; earliest?: string; maxAreaKm2?: number }> = {
  map_flood: { available: true, typicalSeconds: 120, earliest: '2014-10-03', maxAreaKm2: 1600 },
  fetch_surface_water: { available: true, typicalSeconds: 8 },
  analyze_raster: { available: true, typicalSeconds: 15, earliest: '2015-06-23', maxAreaKm2: 1000 },
  inspect_imagery: { available: true, typicalSeconds: 20, earliest: '2015-06-23', maxAreaKm2: 1000 },
  fetch_active_fires: { available: true, typicalSeconds: 4 },
  fetch_built_surface: { available: true, typicalSeconds: 6 },
  query_osm: { available: true, typicalSeconds: 8 },
  detect_anomaly: { available: false, typicalSeconds: 300, earliest: '2017-01-01', maxAreaKm2: 100 },
}
const sit = (over: Partial<Situation> = {}): Situation => ({
  window: WINDOW, areaKm2: 200, now: Date.parse('2025-10-05'), facts: { opticalBlocked: false },
  opInfo: (op) => OPS[op] ?? { available: false, typicalSeconds: 0 }, ...over,
})
const keyOf = (i: { op: string; id: string }) => `${i.op}:${i.id}` // distinct execution per item in these tests
const select = (family: typeof water, p: Record<string, number>, done: string[], s: Situation, executed: string[] = []) =>
  selectNext(family, p, new Set(done), new Set(executed), keyOf, s)

describe('value of information', () => {
  it('is the expected entropy reduction, never negative, and never above the current entropy', () => {
    const p = uniform(water)
    for (const item of water.items) {
      const v = valueOfInformation(p, water.hypotheses, item)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(entropy(p) + 1e-9)
    }
  })

  it('is higher for an item whose outcomes differ between hypotheses than for one that does not', () => {
    const p = uniform(fire)
    const informative = valueOfInformation(p, fire.hypotheses, fire.items.find((i) => i.id === 'fire_dnbr')!)
    // fire_landcover is uniform for two of the four hypotheses and mild for the others
    const weak = valueOfInformation(p, fire.hypotheses, fire.items.find((i) => i.id === 'fire_landcover')!)
    expect(informative).toBeGreaterThan(weak)
  })

  it('is zero for an item every hypothesis predicts alike', () => {
    const item = { ...water.items[0] }
    const flat = water.hypotheses.map((h) => ({ ...h, predicts: { ...h.predicts, [item.id]: { p: Array(binCount(item.scale)).fill(1 / binCount(item.scale)), why: 'flat' } } }))
    expect(valueOfInformation(uniform(water), flat, item)).toBeCloseTo(0, 9)
  })

  it('shrinks as one hypothesis becomes nearly certain', () => {
    const item = water.items.find((i) => i.id === 'sar_new_water')!
    const spread = valueOfInformation(uniform(water), water.hypotheses, item)
    const sure = valueOfInformation({ water_flood_event: 0.97, water_seasonal_inundation: 0.01, water_permanent: 0.01, water_radar_artefact: 0.01 }, water.hypotheses, item)
    expect(sure).toBeLessThan(spread)
  })
})

describe('conditions', () => {
  const item = (id: string) => [...water.items, ...fire.items].find((i) => i.id === id)!

  it('skips a near-real-time source when the window ended long ago', () => {
    const r = applicability(item('fire_hotspots'), sit({ now: Date.parse('2026-10-13') }))
    expect(r).toMatchObject({ runnable: false })
    expect((r as any).reason).toMatch(/near-real-time/)
    expect(applicability(item('fire_hotspots'), sit({ now: Date.parse('2025-10-03') }))).toEqual({ runnable: true })
  })

  it('skips an operation that is not available, that has no data for the window, or that is too small for the area', () => {
    expect((applicability(item('sar_new_water'), sit({ opInfo: () => ({ available: false, typicalSeconds: 1 }) })) as any).reason).toMatch(/not available/)
    expect((applicability(item('sar_new_water'), sit({ window: { start: '2010-01-01', end: '2010-02-01' } })) as any).reason).toMatch(/no data before/)
    expect((applicability(item('sar_new_water'), sit({ areaKm2: 5000 })) as any).reason).toMatch(/limited to 1600/)
  })

  it('skips optical items once cloud has been reported, and only those', () => {
    const cloudy = sit({ facts: { opticalBlocked: true, opticalBlockedReason: 'only 12% of pixels were clear' } })
    expect((applicability(item('optical_ndwi_change'), cloudy) as any).reason).toMatch(/cloud-limited.*12%/)
    expect(applicability(item('sar_new_water'), cloudy)).toEqual({ runnable: true })
    expect(applicability(item('jrc_history'), cloudy)).toEqual({ runnable: true })
  })

  it('needs a long enough window for an anniversary comparison', () => {
    const struct = getFamily('structures')!.items.find((i) => i.id === 'struct_season_alignment')!
    expect(applicability(struct, sit())).toMatchObject({ runnable: false })
    expect(applicability(struct, sit({ window: { start: '2023-06-01', end: '2025-06-01' } }))).toEqual({ runnable: true })
  })
})

describe('choosing radar because it is cloudy', () => {
  // With a clear sky and a cheap optical item, the cheap optical items are chosen first; once an
  // optical result has reported cloud, the optical items drop out and radar is what is left.
  const p = uniform(water)

  it('prefers a cheap optical item when the sky is clear', () => {
    const s = select(water, p, [], sit())
    expect(s.chosen!.item.sensor).not.toBe('radar')
  })

  it('picks a radar item once optical imagery is reported cloud-limited', () => {
    const optical = ['optical_ndwi_change', 'water_vision', 'jrc_history']
    const s = select(water, p, ['jrc_history'], sit({ facts: { opticalBlocked: true, opticalBlockedReason: 'only 12% of pixels were clear' } }), ['archive'])
    expect(s.chosen!.item.sensor).toBe('radar')
    expect(s.chosen!.item.op).toBe('map_flood')
    for (const id of ['optical_ndwi_change', 'water_vision']) {
      expect(s.skipped.find((x) => x.item_id === id)?.reason).toMatch(/cloud/)
    }
    expect(optical.length).toBe(3)
  })

  it('charges nothing for an item that reads a result already in hand', () => {
    const radar = water.items.find((i) => i.id === 'sar_new_water')!
    const s = selectNext(water, p, new Set(), new Set(['same']), () => 'same', sit())
    expect(s.candidates.find((c) => c.item.id === radar.id)!.costS).toBe(0)
  })
})

describe('selection', () => {
  it('lists skipped items with reasons and leaves out items with no value', () => {
    const certain = { water_flood_event: 0.9999, water_seasonal_inundation: 0.00003, water_permanent: 0.00003, water_radar_artefact: 0.00004 }
    const s = select(water, certain, [], sit())
    expect(s.candidates.every((c) => c.voi >= MIN_VOI_BITS)).toBe(true)
  })

  it('does not offer an item already done', () => {
    const s = select(water, uniform(water), ['sar_new_water'], sit())
    expect(s.candidates.find((c) => c.item.id === 'sar_new_water')).toBeUndefined()
  })

  it('names the evidence that would decide, whether or not it could be run', () => {
    const p = { water_flood_event: 0.4, water_seasonal_inundation: 0.35, water_permanent: 0.1, water_radar_artefact: 0.15 }
    const missing = whatWouldDecide(water, p, (item) => (item.id === 'sar_new_water' ? 'could not be measured: flagged' : null), 3)
    expect(missing[0]).toMatchObject({ item_id: 'sar_new_water', why_not: 'could not be measured: flagged' })
    expect(missing[0].voi).toBeGreaterThan(0)
  })
})
