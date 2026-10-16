import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORLDCOVER_LABELS,
  WORLDCOVER_PALETTE,
  fetchWorldCoverData,
  parseWorldCoverStats,
  buildWorldCoverColormap,
} from '../worldcover'
import { _resetCache } from '../cache'

// ─── WORLDCOVER_LABELS ───────────────────────────────────────────────────────

describe('WORLDCOVER_LABELS', () => {
  it('contains class 50 (Built-up)', () => {
    expect(WORLDCOVER_LABELS[50]).toBeDefined()
    expect(WORLDCOVER_LABELS[50].name).toBe('Built-up')
  })

  it('contains class 10 (Tree Cover)', () => {
    expect(WORLDCOVER_LABELS[10]).toBeDefined()
    expect(WORLDCOVER_LABELS[10].name).toBe('Tree Cover')
  })

  it('all entries have a name and a hex color', () => {
    for (const [, { name, color }] of Object.entries(WORLDCOVER_LABELS)) {
      expect(name).toBeTruthy()
      expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('has exactly 11 classes', () => {
    expect(Object.keys(WORLDCOVER_LABELS).length).toBe(11)
  })
})

// ─── WORLDCOVER_PALETTE ──────────────────────────────────────────────────────

describe('WORLDCOVER_PALETTE', () => {
  it('is a classes palette', () => {
    expect(WORLDCOVER_PALETTE.kind).toBe('classes')
  })

  it('has 11 class entries', () => {
    expect(WORLDCOVER_PALETTE.classes.length).toBe(11)
  })

  it('each class has a color and label', () => {
    for (const cls of WORLDCOVER_PALETTE.classes) {
      expect(cls.color).toBeTruthy()
      expect(cls.label).toBeTruthy()
    }
  })
})

// ─── parseWorldCoverStats ────────────────────────────────────────────────────

describe('parseWorldCoverStats', () => {
  const sampleStats = {
    b1: {
      categories: {
        '10.0': 5000,   // Tree Cover
        '40.0': 2000,   // Cropland
        '50.0': 1000,   // Built-up
        '80.0': 500,    // Permanent Water
        '30.0': 1500,   // Grassland
      },
    },
  }

  it('computes builtUpPct from class 50', () => {
    const stats = parseWorldCoverStats(sampleStats)
    expect(stats).not.toBeNull()
    // 1000 / 10000 = 10%
    expect(stats!.builtUpPct).toBeCloseTo(10.0, 0)
  })

  it('computes treeCoverPct from class 10', () => {
    const stats = parseWorldCoverStats(sampleStats)
    // 5000 / 10000 = 50%
    expect(stats!.treeCoverPct).toBeCloseTo(50.0, 0)
  })

  it('dominant class is the most common', () => {
    const stats = parseWorldCoverStats(sampleStats)
    expect(stats!.dominantClass).toBe('Tree Cover')
  })

  it('handles integer string keys (no decimal point)', () => {
    const intStats = { b1: { categories: { '10': 200, '50': 800 } } }
    const stats = parseWorldCoverStats(intStats)
    expect(stats).not.toBeNull()
    expect(stats!.builtUpPct).toBeCloseTo(80.0, 0)
    expect(stats!.treeCoverPct).toBeCloseTo(20.0, 0)
  })

  it('returns null for missing b1.categories', () => {
    expect(parseWorldCoverStats({})).toBeNull()
    expect(parseWorldCoverStats({ b1: {} })).toBeNull()
    expect(parseWorldCoverStats(null)).toBeNull()
  })

  it('returns null when totalPixels is 0', () => {
    expect(parseWorldCoverStats({ b1: { categories: {} } })).toBeNull()
  })

  it('year is always 2021', () => {
    const stats = parseWorldCoverStats(sampleStats)
    expect(stats!.year).toBe(2021)
  })

  // ISS-102 / ISS-107 — the response shape titiler.xyz ACTUALLY returns.
  //
  // Captured live 2026-08-10 (POST /cog/statistics?categorical=true against the
  // signed ESA_WorldCover_10m_2021_v200_N30E072 COG, AOI polygon over Lahore).
  // There is NO `categories` key on this titiler build — the class counts arrive
  // as `histogram: [[counts…], [classValues…]]`. Reading only `categories` meant
  // the parser returned null for every real response, `fetchWorldCoverData`
  // returned null, and `fetch_built_surface` silently answered from OSM instead
  // (the "1.7% built-up over 656 mapped buildings" symptom).
  describe('titiler categorical histogram shape (live-captured)', () => {
    const liveStats = {
      properties: {
        statistics: {
          b1: {
            min: 10, max: 80, mean: 44.486366271972656, count: 164096,
            median: 50, majority: 50, minority: 80, unique: 7,
            histogram: [
              [20159, 151, 2923, 4488, 135980, 617, 34],
              [10, 20, 30, 40, 50, 60, 80],
            ],
            valid_percent: 100,
          },
        },
      },
    }

    it('parses class counts from the histogram when categories is absent', () => {
      const stats = parseWorldCoverStats(liveStats)
      expect(stats).not.toBeNull()
      // 135 980 / 164 352 = 82.7% built-up — this AOI is inside Lahore.
      expect(stats!.builtUpPct).toBeCloseTo(82.7, 0)
      expect(stats!.dominantClass).toBe('Built-up')
      expect(stats!.totalPixels).toBe(164352)
    })

    it('reads b1 from the POST (properties.statistics) response envelope', () => {
      // The GET envelope is `{b1:…}`; the POST envelope is a GeoJSON Feature.
      expect(parseWorldCoverStats(liveStats)).not.toBeNull()
      expect(parseWorldCoverStats({ b1: liveStats.properties.statistics.b1 })).not.toBeNull()
    })

    it('handles a continuous histogram (edges = counts + 1) by lower edge', () => {
      const continuous = { b1: { histogram: [[3, 7], [10, 50, 90]] } }
      const stats = parseWorldCoverStats(continuous)
      expect(stats!.treeCoverPct).toBeCloseTo(30, 0)   // class 10
      expect(stats!.builtUpPct).toBeCloseTo(70, 0)     // class 50
    })

    it('still prefers an explicit categories block when titiler provides one', () => {
      const both = {
        b1: {
          categories: { '50': 1000 },
          histogram: [[1, 1], [10, 20]],
        },
      }
      expect(parseWorldCoverStats(both)!.builtUpPct).toBe(100)
    })

    it('returns null for an empty or malformed histogram', () => {
      expect(parseWorldCoverStats({ b1: { histogram: [[], []] } })).toBeNull()
      expect(parseWorldCoverStats({ b1: { histogram: [[1, 2]] } })).toBeNull()
      expect(parseWorldCoverStats({ b1: { histogram: 'nope' } })).toBeNull()
    })
  })
})

// ─── fetchWorldCoverData — ISS-102 ───────────────────────────────────────────
//
// GET /cog/statistics?bbox= returns whole-COG stats. For a WorldCover tile that
// is a 3°×3° (~330 km) region — measured live 2026-08-10 over the same AOI:
//   GET  (bbox, whole tile) → majority Cropland,  built-up  3.8%
//   POST (AOI polygon)      → majority Built-up,  built-up 82.9%
// The AOI is inside Lahore. Only the POST answer is about the AOI.

describe('fetchWorldCoverData (ISS-102 polygon clip)', () => {
  const AOI = {
    type: 'Polygon',
    coordinates: [[[74.28, 31.50], [74.36, 31.50], [74.36, 31.55], [74.28, 31.55], [74.28, 31.50]]],
  }
  const BBOX = [74.28, 31.50, 74.36, 31.55]

  const STAC_ITEM = {
    features: [{ id: 'wc', assets: { map: { href: 'https://acct.blob.core.windows.net/esa/wc.tif' } } }],
  }
  const STATS = {
    properties: { statistics: { b1: { histogram: [[100, 900], [10, 50]], count: 1000 } } },
  }

  function installMock() {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url)
      if (u.includes('/stac/v1/search')) return { ok: true, status: 200, json: async () => STAC_ITEM } as any
      if (u.includes('/api/sas/')) return { ok: true, status: 200, json: async () => ({ token: 'sas=1' }) } as any
      if (u.includes('/cog/statistics')) {
        return { ok: true, status: 200, json: async () => STATS, _init: init } as any
      }
      return { ok: false, status: 404, json: async () => ({}) } as any
    }))
  }

  beforeEach(() => { _resetCache(); installMock() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('POSTs the drawn AOI polygon and never sends bbox=', async () => {
    const out = await fetchWorldCoverData(BBOX, AOI)
    expect(out).not.toBeNull()
    expect(out!.stats.builtUpPct).toBeCloseTo(90, 0)
    expect(out!.clip).toBe('polygon')

    const statsCall = vi.mocked(fetch).mock.calls.find((c) => String(c[0]).includes('/cog/statistics'))
    expect(statsCall, 'no /cog/statistics call made').toBeTruthy()
    expect(String(statsCall![0])).not.toContain('bbox=')
    expect(statsCall![1]!.method).toBe('POST')
    const body = JSON.parse(statsCall![1]!.body as string)
    expect(body.geometry).toEqual(AOI)
  })

  it('falls back to a bbox RECTANGLE polygon when no AOI polygon is supplied', async () => {
    const out = await fetchWorldCoverData(BBOX)
    expect(out!.clip).toBe('bbox')

    const statsCall = vi.mocked(fetch).mock.calls.find((c) => String(c[0]).includes('/cog/statistics'))
    expect(String(statsCall![0])).not.toContain('bbox=')
    const body = JSON.parse(statsCall![1]!.body as string)
    expect(body.geometry.type).toBe('Polygon')
    expect(body.geometry.coordinates[0]).toHaveLength(5)
  })
})

// ─── buildWorldCoverColormap ─────────────────────────────────────────────────

describe('buildWorldCoverColormap', () => {
  it('returns a non-empty URL-encoded string', () => {
    const cm = buildWorldCoverColormap()
    expect(cm).toBeTruthy()
    expect(typeof cm).toBe('string')
  })

  it('decodes to a JSON object with 11 entries', () => {
    const cm = buildWorldCoverColormap()
    const obj = JSON.parse(decodeURIComponent(cm))
    expect(Object.keys(obj).length).toBe(11)
  })

  it('each value is a 4-element RGBA array', () => {
    const cm = buildWorldCoverColormap()
    const obj = JSON.parse(decodeURIComponent(cm))
    for (const rgba of Object.values(obj) as any[]) {
      expect(rgba).toHaveLength(4)
      expect(rgba[3]).toBe(220)  // alpha
    }
  })
})
