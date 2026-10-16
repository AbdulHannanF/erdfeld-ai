import { describe, expect, it } from 'vitest'

import {
  CATALOGUE, FAMILY_IDS, binCount, binLabel, binOf, findHypothesis, getFamily, observesWindow, validateCatalogue, type Family,
} from '../catalogue'
import { FEATURES } from '../features'
import { registryOpInfo } from '../run'

describe('the catalogue', () => {
  it('is structurally sound', () => {
    expect(validateCatalogue()).toEqual([])
  })

  it('has the four families with the hypotheses the design names', () => {
    expect(CATALOGUE.map((f) => f.id).sort()).toEqual([...FAMILY_IDS].sort())
    const ids = (f: string) => getFamily(f)!.hypotheses.map((h) => h.id)
    expect(ids('water')).toEqual(expect.arrayContaining(['water_flood_event', 'water_seasonal_inundation', 'water_permanent', 'water_radar_artefact']))
    expect(ids('vegetation_loss')).toEqual(expect.arrayContaining(['veg_harvest_senescence', 'veg_clearing', 'veg_fire_burn_scar', 'veg_drought_stress', 'veg_cloud_shadow_artefact']))
    expect(ids('fire')).toEqual(expect.arrayContaining(['fire_wildfire', 'fire_agricultural_burning', 'fire_artefact']))
    expect(ids('structures')).toEqual(expect.arrayContaining(['struct_construction', 'struct_demolition', 'struct_temporary_surfaces', 'struct_imagery_mismatch', 'struct_outdated_inventory']))
  })

  it('reads only registered operations and defined features', () => {
    for (const f of CATALOGUE) {
      for (const item of f.items) {
        expect(registryOpInfo(item.op).typicalSeconds, `${item.id} -> ${item.op}`).toBeGreaterThanOrEqual(0)
        if (item.feature !== 'vision') expect(FEATURES[item.feature], `${item.id} -> ${item.feature}`).toBeTypeOf('function')
      }
    }
  })

  it('gives every threshold and category a reason, and every prediction a reason', () => {
    for (const f of CATALOGUE) {
      for (const item of f.items) {
        const reasons = item.scale.kind === 'cuts' ? item.scale.cuts.map((c) => c.why) : item.scale.categories.map((c) => c.why)
        expect(reasons.every((w) => w.length >= 5)).toBe(true)
      }
      for (const h of f.hypotheses) for (const p of Object.values(h.predicts)) expect(p.why.length).toBeGreaterThan(4)
    }
  })

  it('caps every vision reading to a likelihood ratio of 0.5 to 2', () => {
    const vision = CATALOGUE.flatMap((f) => f.items).filter((i) => i.feature === 'vision')
    expect(vision).toHaveLength(4)
    for (const v of vision) expect(v.lrCap).toEqual([0.5, 2])
  })

  describe('new structures', () => {
    const f = getFamily('structures')!
    it('never treats a mapped footprint as proof: the inventory item is weak and says so', () => {
      const osm = f.items.find((i) => i.op === 'query_osm')!
      expect(osm.lrCap![1]).toBeLessThanOrEqual(1.5)
      expect(osm.lrCap![0]).toBeGreaterThanOrEqual(0.67)
      expect(osm.caveat).toMatch(/not evidence that a building is new/)
    })
    it('compares dated imagery and uses built-surface data', () => {
      const ops = f.items.map((i) => i.op)
      expect(ops).toContain('analyze_raster')
      expect(ops).toContain('fetch_built_surface')
      const change = f.items.find((i) => i.feature === 'ndbi_rise')!
      expect(change.args).toMatchObject({ operation: 'change', date: '{{window.start}}', date2: '{{window.end}}' })
    })
    it('states the temporal limits of building datasets and of the baseline', () => {
      const text = f.limits.join(' ')
      expect(text).toMatch(/edit and release dates, not construction dates/)
      expect(text).toMatch(/single-year \(2021\)/)
    })
  })

  it('rejects a malformed catalogue', () => {
    const bad: Family = JSON.parse(JSON.stringify(getFamily('water')))
    bad.hypotheses[0].predicts.sar_new_water.p = [0.5, 0.5]
    bad.hypotheses[1].predicts.sar_new_water.p = [0.97, 0.01, 0.01, 0.0]
    delete (bad.hypotheses[2].predicts as any).jrc_history
    const problems = validateCatalogue([bad])
    expect(problems.some((p) => /2 probabilities for 4 bins/.test(p))).toBe(true)
    expect(problems.some((p) => /below 0.01/.test(p))).toBe(true)
    expect(problems.some((p) => /no prediction for jrc_history/.test(p))).toBe(true)
  })

  it('places values on a scale', () => {
    const scale = getFamily('fire')!.items.find((i) => i.id === 'fire_dnbr')!.scale
    expect(binCount(scale)).toBe(4)
    expect(binOf(scale, 0.05)).toBe(0)
    expect(binOf(scale, 0.1)).toBe(1)
    expect(binOf(scale, 0.3)).toBe(2)
    expect(binOf(scale, 0.9)).toBe(3)
    expect(binOf(scale, Number.NaN)).toBe(-1)
    expect(binLabel(scale, 3)).toMatch(/>= 0.44/)
    const cats = getFamily('water')!.items.find((i) => i.id === 'sar_orbit_geometry')!.scale
    expect(binOf(cats, 'direction')).toBe(1)
    expect(binOf(cats, 'nonsense')).toBe(-1)
  })

  it('finds a hypothesis by id', () => {
    expect(findHypothesis('fire_wildfire')?.family.id).toBe('fire')
    expect(findHypothesis('nope')).toBeUndefined()
  })
})

describe('observesWindow', () => {
  it('is false for archive baselines and quality checks, true for measurements of the window', () => {
    const all = CATALOGUE.flatMap((f) => f.items)
    const by = (id: string) => all.find((i) => i.id === id)!
    for (const id of ['jrc_history', 'fire_landcover', 'struct_baseline_builtup', 'struct_osm_density', 'sar_orbit_geometry', 'struct_season_alignment']) {
      expect(observesWindow(by(id)), id).toBe(false)
    }
    for (const id of ['sar_new_water', 'optical_ndwi_change', 'veg_ndvi_change', 'fire_dnbr', 'fire_hotspots', 'struct_ndbi_change']) {
      expect(observesWindow(by(id)), id).toBe(true)
    }
  })
})
