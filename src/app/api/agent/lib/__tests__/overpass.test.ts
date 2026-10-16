import { describe, expect, it } from 'vitest'
import { OSM_TAG_MAP, darken, mapFeatureToCvModel, mergeOsmResults, normalizePlural, resolveOsmTags, splitBbox } from '../overpass'

describe('normalizePlural', () => {
  it('returns the input unchanged when stem is not a known key', () => {
    expect(normalizePlural('xyzzy')).toBe('xyzzy')
  })

  it('strips a plain s when stem is a known key', () => {
    expect(normalizePlural('buildings')).toBe('building')
  })

  it('strips ies → y when stem is a known key', () => {
    // "cemeteries" → "cemetery" via -ies rule (cemetery is in OSM_TAG_MAP)
    expect(normalizePlural('cemeteries')).toBe('cemetery')
  })
})

describe('resolveOsmTags', () => {
  it('resolves "buildings" to the Polygon building entry', () => {
    const entry = resolveOsmTags('buildings')
    expect(entry.geom).toBe('Polygon')
    expect(entry.tags).toContain('"building"')
  })

  it('resolves "lakes" via synonyms to the lake entry', () => {
    const entry = resolveOsmTags('lakes')
    expect(entry.geom).toBe('Polygon')
    expect(entry.label).toBe('Lakes')
  })

  it('resolves "rivers" to a LineString', () => {
    const entry = resolveOsmTags('rivers')
    expect(entry.geom).toBe('LineString')
  })

  it('picks a longer-token match in a multi-word query', () => {
    const entry = resolveOsmTags('show me all the hospitals please')
    expect(entry.geom).toBe('Polygon')
    expect(entry.label).toBe('Hospitals')
  })

  it('falls back to LineString for unknown linear-keyword query', () => {
    const entry = resolveOsmTags('cattle trail')
    expect(entry.geom).toBe('LineString')
  })

  it('falls back to Point for unknown point-keyword query', () => {
    const entry = resolveOsmTags('unknown hydrant variant')
    expect(entry.geom).toBe('Point')
  })

  it('strips trailing punctuation', () => {
    const entry = resolveOsmTags('buildings?')
    expect(entry.label).toBe('Buildings')
  })
})

describe('OSM_TAG_MAP', () => {
  it('has a Polygon entry for "building"', () => {
    expect(OSM_TAG_MAP.building.geom).toBe('Polygon')
  })

  it('has a LineString entry for "road"', () => {
    expect(OSM_TAG_MAP.road.geom).toBe('LineString')
  })

  it('has a Point entry for "manhole"', () => {
    expect(OSM_TAG_MAP.manhole.geom).toBe('Point')
  })
})

describe('darken', () => {
  it('returns black when fully darkened (factor=1)', () => {
    expect(darken('#ff0000', 1)).toBe('#000000')
  })

  it('returns the original color when factor=0', () => {
    expect(darken('#ff0000', 0)).toBe('#ff0000')
  })
})

describe('splitBbox', () => {
  const parent: [number, number, number, number] = [0, 0, 2, 2]

  it('returns four quadrants', () => {
    expect(splitBbox(parent)).toHaveLength(4)
  })

  it('orders quadrants NW, NE, SW, SE with the shared midpoint', () => {
    const [nw, ne, sw, se] = splitBbox(parent)
    expect(nw).toEqual([0, 1, 1, 2])
    expect(ne).toEqual([1, 1, 2, 2])
    expect(sw).toEqual([0, 0, 1, 1])
    expect(se).toEqual([1, 0, 2, 1])
  })

  it('quadrants tile the parent exactly (areas sum, no gap/overlap)', () => {
    const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1])
    const total = splitBbox(parent).reduce((s, q) => s + area(q), 0)
    expect(total).toBeCloseTo(area(parent))
  })

  it('handles negative / cross-equator bboxes via true midpoints', () => {
    const [nw] = splitBbox([-10, -10, 10, 10])
    expect(nw).toEqual([-10, 0, 0, 10])
  })
})

describe('mergeOsmResults', () => {
  it('dedupes the same (type,id) across overlapping quadrants', () => {
    const a = [{ type: 'way', id: 1 }, { type: 'way', id: 2 }]
    const b = [{ type: 'way', id: 2 }, { type: 'way', id: 3 }]
    const merged = mergeOsmResults([a, b])
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('keeps elements that share an id but differ in type', () => {
    const merged = mergeOsmResults([[{ type: 'node', id: 5 }], [{ type: 'way', id: 5 }]])
    expect(merged).toHaveLength(2)
  })

  it('returns [] for no groups and skips empty groups', () => {
    expect(mergeOsmResults([])).toEqual([])
    expect(mergeOsmResults([[], []])).toEqual([])
  })

  it('preserves first occurrence order', () => {
    const merged = mergeOsmResults([[{ type: 'way', id: 9 }], [{ type: 'way', id: 9 }, { type: 'way', id: 1 }]])
    expect(merged.map((e) => e.id)).toEqual([9, 1])
  })
})

describe('mapFeatureToCvModel', () => {
  it('maps water features to water_channel', () => {
    expect(mapFeatureToCvModel('lake')).toBe('water_channel')
  })

  it('maps roads to road_damage', () => {
    expect(mapFeatureToCvModel('road')).toBe('road_damage')
  })

  it('maps solar to solar_panel', () => {
    expect(mapFeatureToCvModel('solar panels')).toBe('solar_panel')
  })

  it('defaults to informal_struct for buildings', () => {
    expect(mapFeatureToCvModel('mystery building')).toBe('informal_struct')
  })
})

describe('resolveOsmTags name-regex escaping', () => {
  it('cannot be broken out of the quoted filter by injected QL', () => {
    const entry = resolveOsmTags('qzx lamp"]; out; node["x"~"')
    const tag = entry.tags[0]
    // every quote inside the literal is backslash-escaped
    expect(tag.slice('"name"~"'.length, tag.lastIndexOf('",i'))).not.toMatch(/(^|[^\\])"/)
    expect(tag.endsWith('",i')).toBe(true)
  })

  it('escapes regex metacharacters and caps the length', () => {
    const entry = resolveOsmTags('qzx.*(bar)|baz lamp ' + 'x'.repeat(500))
    expect(entry.tags[0]).toContain('qzx\\.\\*\\(bar\\)\\|baz')
    expect(entry.tags[0].length).toBeLessThan(200)
  })
})
