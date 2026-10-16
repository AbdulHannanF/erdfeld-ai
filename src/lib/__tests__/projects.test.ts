import { describe, expect, it } from 'vitest'
import {
  canAccessProject,
  fromDto,
  generateShareToken,
  isValidShareToken,
  toDto,
  type StoreSnapshot,
} from '../projects'
import type { ChatMessage, MapLayer, AOI } from '@/store/useStore'

const AOI_FIXTURE: AOI = {
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [[[-0.13, 51.5], [-0.12, 51.5], [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.5]]],
  },
  center: { lng: -0.125, lat: 51.505 },
}

const RASTER_LAYER: MapLayer = {
  id: 'ndvi-active',
  name: 'NDVI',
  type: 'raster',
  imageBase64: 'data:image/png;base64,AAAA',
  bounds: [-0.13, 51.5, -0.12, 51.51],
  visible: true,
  opacity: 0.8,
  provenance: { source: 'Sentinel-2', method: 'titiler render', clip: 'polygon', date: '2025-09' },
  confidence: 'high',
  palette: { kind: 'gradient', stops: [{ value: 0, color: '#000' }], min: 0, max: 1, unit: 'NDVI' },
  resultId: 'fetch_ndvi-0',
  tool: 'fetch_ndvi',
  summaryData: { mean: 0.42, vegetation_pct: 67 },
  aoiKey: 'aoi_abc_123',
}

const GEOJSON_LAYER: MapLayer = {
  id: 'buildings-0',
  name: 'Buildings',
  type: '3dtiles',
  geojson: { type: 'FeatureCollection', features: [] },
  visible: false,
  opacity: 1,
  render: 'extrusion',
  heightProperty: 'height',
  color: '#10b981',
}

const MESSAGES: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'What is the vegetation here?', timestamp: 1000 },
  {
    id: 'm2',
    role: 'assistant',
    content: 'NDVI mean is [[fetch_ndvi-0#mean]].',
    timestamp: 2000,
    toolResults: {
      'fetch_ndvi-0': {
        resultId: 'fetch_ndvi-0',
        tool: 'fetch_ndvi',
        summaryData: { mean: 0.42 },
        confidence: 'high',
      },
    },
  },
  // Empty streaming placeholder — must be dropped by toDto.
  { id: 'm3', role: 'assistant', content: '', timestamp: 3000 },
]

const SNAPSHOT: StoreSnapshot = {
  name: 'Berlin test',
  aoi: AOI_FIXTURE,
  mapStyle: 'satellite',
  layers: [RASTER_LAYER, GEOJSON_LAYER],
  messages: MESSAGES,
}

describe('projects serialization', () => {
  it('toDto → JSON round-trip → fromDto preserves AOI, layers, and map style', () => {
    const dto = toDto(SNAPSHOT)
    // Simulate the DB store/transport boundary.
    const roundTripped = JSON.parse(JSON.stringify(dto))
    const restored = fromDto(roundTripped)

    expect(restored.aoi).toEqual(AOI_FIXTURE)
    expect(restored.mapStyle).toBe('satellite')
    expect(restored.layers).toHaveLength(2)
  })

  it('restores layer provenance + confidence verbatim (honesty requirement)', () => {
    const restored = fromDto(JSON.parse(JSON.stringify(toDto(SNAPSHOT))))
    const ndvi = restored.layers.find((l) => l.id === 'ndvi-active')!
    expect(ndvi.provenance).toEqual(RASTER_LAYER.provenance)
    expect(ndvi.confidence).toBe('high')
    expect(ndvi.summaryData).toEqual({ mean: 0.42, vegetation_pct: 67 })
    expect(ndvi.resultId).toBe('fetch_ndvi-0')
    expect(ndvi.palette).toEqual(RASTER_LAYER.palette)
  })

  it('preserves extrusion render metadata on geojson layers', () => {
    const restored = fromDto(JSON.parse(JSON.stringify(toDto(SNAPSHOT))))
    const b = restored.layers.find((l) => l.id === 'buildings-0')!
    expect(b.render).toBe('extrusion')
    expect(b.heightProperty).toBe('height')
    expect(b.visible).toBe(false)
    expect(b.geojson).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('drops empty (streaming-placeholder) messages and keeps real ones', () => {
    const dto = toDto(SNAPSHOT)
    expect(dto.messages).toHaveLength(2)
    expect(dto.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('preserves message citation snapshots so pills resolve after reload', () => {
    const restored = fromDto(JSON.parse(JSON.stringify(toDto(SNAPSHOT))))
    const assistant = restored.messages.find((m) => m.id === 'm2')!
    expect(assistant.toolResults?.['fetch_ndvi-0']?.summaryData).toEqual({ mean: 0.42 })
  })

  it('defaults a blank name and tolerates a null AOI', () => {
    const dto = toDto({ name: '   ', aoi: null, mapStyle: 'dark', layers: [], messages: [] })
    expect(dto.name).toBe('Untitled project')
    expect(dto.aoi).toBeNull()
    expect(fromDto(dto).aoi).toBeNull()
  })

  it('does not leak undefined-valued keys into the DTO (clean JSON)', () => {
    const dto = toDto(SNAPSHOT)
    const layer = dto.layers.find((l) => l.id === 'buildings-0')!
    expect('tileUrl' in layer).toBe(false)
    expect('imageBase64' in layer).toBe(false)
    expect('resultId' in layer).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P6.2 — shareable links
// ---------------------------------------------------------------------------

describe('canAccessProject (owner-token enforcement)', () => {
  it('allows the matching owner', () => {
    expect(canAccessProject('owner-abc', 'owner-abc')).toBe(true)
  })

  it('denies a non-matching requester', () => {
    expect(canAccessProject('owner-abc', 'someone-else')).toBe(false)
    expect(canAccessProject('owner-abc', '')).toBe(false)
  })

  it('treats anonymous/legacy (null/undefined) projects as open', () => {
    expect(canAccessProject(null, 'anyone')).toBe(true)
    expect(canAccessProject(undefined, '')).toBe(true)
  })
})

describe('generateShareToken', () => {
  it('produces a token of the requested length from the safe alphabet', () => {
    const t = generateShareToken(8)
    expect(t).toHaveLength(8)
    expect(isValidShareToken(t)).toBe(true)
    // No ambiguous chars.
    expect(/[01OIl]/.test(t)).toBe(false)
  })

  it('is deterministic given an injected RNG', () => {
    // Constant index → repeated first alphabet char.
    expect(generateShareToken(5, () => 0)).toBe('22222')
  })

  it('maps sequential RNG output to sequential alphabet positions', () => {
    let n = 0
    const token = generateShareToken(4, () => n++)
    // positions 0,1,2,3 → '2','3','4','5'
    expect(token).toBe('2345')
  })
})

describe('isValidShareToken', () => {
  it('accepts well-formed tokens', () => {
    expect(isValidShareToken('Q4kT2abc')).toBe(true)
    expect(isValidShareToken('abcd')).toBe(true)
  })

  it('rejects empty, too-short, too-long, or off-alphabet tokens', () => {
    expect(isValidShareToken('')).toBe(false)
    expect(isValidShareToken('ab')).toBe(false)
    expect(isValidShareToken('a'.repeat(40))).toBe(false)
    expect(isValidShareToken('has space')).toBe(false)
    expect(isValidShareToken('has/slash')).toBe(false)
    expect(isValidShareToken('0OIl1')).toBe(false) // ambiguous chars are not in the alphabet
    // @ts-expect-error — runtime guard for non-strings
    expect(isValidShareToken(null)).toBe(false)
  })
})
