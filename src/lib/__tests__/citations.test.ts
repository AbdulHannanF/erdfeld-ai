import { describe, it, expect } from 'vitest'
import {
  parseCitations,
  hasCitations,
  splitTextWithCitations,
  stripCitationMarkup,
  resolveCitation,
  isChartableArray,
  formatCitationValue,
  buildCitationHint,
  type CitableToolResult,
} from '../citations'

const TOOL_RESULTS: Record<string, CitableToolResult> = {
  'fetch_ndvi-0': {
    tool: 'fetch_ndvi',
    resultId: 'fetch_ndvi-0',
    summaryData: { mean: 0.42, vegetation_pct: 64, scene_date: '2024-03-15' },
    provenance: { source: 'Sentinel-2 L2A', method: 'titiler bbox stats', clip: 'bbox' },
    confidence: 'high',
  },
  'classify_land_cover-1': {
    tool: 'classify_land_cover',
    resultId: 'classify_land_cover-1',
    summaryData: {
      dominant_class: 'Forest',
      land_cover: [
        { label: 'Forest', value: 60 },
        { label: 'Cropland', value: 30 },
        { label: 'Water', value: 10 },
      ],
    },
    confidence: 'medium',
  },
}

describe('parseCitations', () => {
  it('extracts a single marker', () => {
    const refs = parseCitations('Mean NDVI was 0.42 [[fetch_ndvi-0#mean]] over the AOI.')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ resultId: 'fetch_ndvi-0', key: 'mean', raw: '[[fetch_ndvi-0#mean]]' })
  })

  it('extracts multiple markers in order', () => {
    const refs = parseCitations(
      'NDVI 0.42 [[fetch_ndvi-0#mean]]; veg 64% [[fetch_ndvi-0#vegetation_pct]].',
    )
    expect(refs.map((r) => r.key)).toEqual(['mean', 'vegetation_pct'])
  })

  it('returns empty for text with no markers', () => {
    expect(parseCitations('plain text, 42 things')).toEqual([])
  })

  it('returns empty for empty/undefined input', () => {
    expect(parseCitations('')).toEqual([])
    // @ts-expect-error testing nullish guard
    expect(parseCitations(undefined)).toEqual([])
  })

  it('ignores malformed markers (no ordinal, no hash)', () => {
    expect(parseCitations('[[fetch_ndvi#mean]] [[fetch_ndvi-0]] [fetch_ndvi-0#mean]')).toEqual([])
  })

  it('records the character index of each marker', () => {
    const text = 'abc [[a-0#b]]'
    const refs = parseCitations(text)
    expect(refs[0].index).toBe(4)
  })

  // Real markup captured from the running app (2026-08-17 QA sweep, finding #7).
  // parseCitations stays strict on purpose — splitTextWithCitations (below) is
  // where these get resolved into real citations or dropped.
  it('does not match a multi-key marker with `=value` suffixes', () => {
    const text = 'Elevation Range: 2334 m to 4093 m ' +
      '[[fetch_dem-1#min_elevation_m=2334, fetch_dem-1#max_elevation_m=4093]]'
    expect(parseCitations(text)).toEqual([])
  })

  it('does not match a bare tool-name marker', () => {
    expect(parseCitations('...over a longer duration [[detect_change]].')).toEqual([])
  })
})

describe('hasCitations', () => {
  it('is true when a marker exists', () => {
    expect(hasCitations('x [[t-0#k]] y')).toBe(true)
  })
  it('is false otherwise', () => {
    expect(hasCitations('no markers here')).toBe(false)
  })
})

describe('splitTextWithCitations', () => {
  it('splits text around a marker preserving surrounding text', () => {
    const segs = splitTextWithCitations('Mean 0.42 [[fetch_ndvi-0#mean]] done.')
    expect(segs).toEqual([
      { type: 'text', value: 'Mean 0.42 ' },
      { type: 'citation', ref: expect.objectContaining({ resultId: 'fetch_ndvi-0', key: 'mean' }) },
      { type: 'text', value: ' done.' },
    ])
  })

  it('handles a marker at the very start', () => {
    const segs = splitTextWithCitations('[[t-0#k]] tail')
    expect(segs[0].type).toBe('citation')
    expect(segs[1]).toEqual({ type: 'text', value: ' tail' })
  })

  it('handles back-to-back markers', () => {
    const segs = splitTextWithCitations('[[a-0#x]][[b-1#y]]')
    expect(segs.filter((s) => s.type === 'citation')).toHaveLength(2)
    expect(segs.filter((s) => s.type === 'text')).toHaveLength(0)
  })

  it('returns the whole string as one text segment when no markers', () => {
    expect(splitTextWithCitations('just text')).toEqual([{ type: 'text', value: 'just text' }])
  })

  it('returns empty array for empty string', () => {
    expect(splitTextWithCitations('')).toEqual([])
  })

  // Real leaked markup captured from the running app (2026-08-17 QA sweep,
  // finding #7): CITATION_PATTERN matches exactly one shape, so both of these reached the
  // user as literal brackets before the broad-marker rewrite.
  it('splits a multi-key marker with `=value` suffixes into one citation per key', () => {
    const text = 'Elevation Range: 2334 m to 4093 m ' +
      '[[fetch_dem-1#min_elevation_m=2334, fetch_dem-1#max_elevation_m=4093]]'
    const segs = splitTextWithCitations(text)
    const citations = segs.filter((s) => s.type === 'citation')
    expect(citations).toHaveLength(2)
    expect(citations.map((s) => (s as any).ref)).toMatchObject([
      { resultId: 'fetch_dem-1', key: 'min_elevation_m' },
      { resultId: 'fetch_dem-1', key: 'max_elevation_m' },
    ])
    // No raw bracket markup survives in any text segment either.
    for (const s of segs) {
      if (s.type === 'text') expect(s.value).not.toMatch(/\[\[|\]\]/)
    }
  })

  it('drops a bare tool-name marker with no well-formed ref, keeping the surrounding text', () => {
    const text = '...look for land cover changes over a longer duration [[detect_change]].'
    const segs = splitTextWithCitations(text)
    expect(segs.some((s) => s.type === 'citation')).toBe(false)
    for (const s of segs) {
      if (s.type === 'text') expect(s.value).not.toMatch(/\[\[|\]\]/)
    }
    expect(segs.map((s) => (s.type === 'text' ? s.value : '')).join('')).toBe(
      '...look for land cover changes over a longer duration .',
    )
  })
})

describe('stripCitationMarkup', () => {
  it('removes a well-formed marker', () => {
    expect(stripCitationMarkup('Mean 0.42 [[fetch_ndvi-0#mean]] over the AOI.')).toBe(
      'Mean 0.42 over the AOI.',
    )
  })

  it('removes a leaked multi-key marker with `=value` suffixes', () => {
    const text = 'Elevation Range: 2334 m to 4093 m ' +
      '[[fetch_dem-1#min_elevation_m=2334, fetch_dem-1#max_elevation_m=4093]]'
    expect(stripCitationMarkup(text)).toBe('Elevation Range: 2334 m to 4093 m')
  })

  it('removes a leaked bare tool-name marker', () => {
    const text = '...look for land cover changes over a longer duration [[detect_change]].'
    expect(stripCitationMarkup(text)).toBe('...look for land cover changes over a longer duration .')
  })

  it('is a no-op when there is no marker', () => {
    expect(stripCitationMarkup('plain text, no markers')).toBe('plain text, no markers')
  })

  it('returns empty string for empty input', () => {
    expect(stripCitationMarkup('')).toBe('')
  })
})

describe('resolveCitation', () => {
  it('resolves a valid scalar citation', () => {
    const r = resolveCitation({ resultId: 'fetch_ndvi-0', key: 'mean' }, TOOL_RESULTS)
    expect(r).toMatchObject({ resolved: true, tool: 'fetch_ndvi', value: 0.42, confidence: 'high' })
    expect(r.provenance?.source).toBe('Sentinel-2 L2A')
  })

  it('flags an unknown result_id as unresolved', () => {
    const r = resolveCitation({ resultId: 'ghost_tool-9', key: 'mean' }, TOOL_RESULTS)
    expect(r.resolved).toBe(false)
    expect(r.tool).toBeNull()
    expect(r.value).toBeNull()
  })

  it('flags a known result_id with an unknown key as unresolved', () => {
    const r = resolveCitation({ resultId: 'fetch_ndvi-0', key: 'nonexistent' }, TOOL_RESULTS)
    expect(r.resolved).toBe(false)
    expect(r.tool).toBe('fetch_ndvi')
    expect(r.value).toBeNull()
  })

  it('resolves an array (chartable) value', () => {
    const r = resolveCitation({ resultId: 'classify_land_cover-1', key: 'land_cover' }, TOOL_RESULTS)
    expect(r.resolved).toBe(true)
    expect(isChartableArray(r.value)).toBe(true)
  })

  it('treats a falsy-but-present value (0) as resolved', () => {
    const tr: Record<string, CitableToolResult> = {
      't-0': { tool: 't', resultId: 't-0', summaryData: { zero: 0 } },
    }
    const r = resolveCitation({ resultId: 't-0', key: 'zero' }, tr)
    expect(r.resolved).toBe(true)
    expect(r.value).toBe(0)
  })
})

describe('isChartableArray', () => {
  it('accepts a well-formed series', () => {
    expect(isChartableArray([{ label: 'A', value: 1 }, { label: 'B', value: 2 }])).toBe(true)
  })
  it('rejects empty arrays', () => {
    expect(isChartableArray([])).toBe(false)
  })
  it('rejects scalars and strings', () => {
    expect(isChartableArray(5)).toBe(false)
    expect(isChartableArray('x')).toBe(false)
  })
  it('rejects malformed entries', () => {
    expect(isChartableArray([{ label: 'A', value: NaN }])).toBe(false)
    // @ts-expect-error wrong shape
    expect(isChartableArray([{ label: 'A' }])).toBe(false)
  })
})

describe('formatCitationValue', () => {
  it('formats integers without decimals', () => {
    expect(formatCitationValue(64)).toBe('64')
  })
  it('rounds long floats', () => {
    expect(formatCitationValue(0.123456)).toBe('0.123')
  })
  it('passes strings through', () => {
    expect(formatCitationValue('2024-03-15')).toBe('2024-03-15')
  })
  it('joins array values', () => {
    expect(formatCitationValue([{ label: 'A', value: 1 }, { label: 'B', value: 2 }])).toBe('A: 1, B: 2')
  })
  it('handles null', () => {
    expect(formatCitationValue(null)).toBe('—')
  })
})

describe('buildCitationHint', () => {
  it('lists scalar fields', () => {
    const hint = buildCitationHint('fetch_ndvi-0', { mean: 0.42, vegetation_pct: 64 })
    expect(hint).toContain('citation_id: fetch_ndvi-0')
    expect(hint).toContain('mean=0.42')
    expect(hint).toContain('vegetation_pct=64')
  })

  it('renders array fields compactly', () => {
    const hint = buildCitationHint('classify_land_cover-1', {
      land_cover: [{ label: 'Forest', value: 60 }, { label: 'Water', value: 10 }],
    })
    expect(hint).toContain('land_cover=[Forest:60, Water:10]')
  })

  it('returns empty string when there is nothing citable', () => {
    expect(buildCitationHint('t-0')).toBe('')
    expect(buildCitationHint('t-0', {})).toBe('')
  })
})

describe('content-hash result ids', () => {
  it('parses [[r_<16 hex>#key]] as well as the older ordinal ids', () => {
    const refs = parseCitations('NDVI 0.4 [[r_3fa9c2d41b7e08aa#mean]] and [[fetch_dem-1#min]]')
    expect(refs.map((r) => [r.resultId, r.key])).toEqual([['r_3fa9c2d41b7e08aa', 'mean'], ['fetch_dem-1', 'min']])
  })
})
