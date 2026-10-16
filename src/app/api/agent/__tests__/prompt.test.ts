import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPrompt } from '../prompt'
import type { ManifestLayer, PointFocus } from '../lib/types'

const AOI = {
  type: 'Polygon',
  coordinates: [[[-0.13, 51.50], [-0.12, 51.50], [-0.12, 51.51], [-0.13, 51.51], [-0.13, 51.50]]],
}

describe('buildPrompt — base (no focus)', () => {
  const prompt = buildPrompt(AOI, 'en')

  it('includes the AOI section and the full rule set', () => {
    expect(prompt).toContain('## Area of Interest (AOI)')
    expect(prompt).toContain('### Rule 1 — Every question is answered by a plan')
    expect(prompt).toContain('### Rule 4 — Reuse existing layers')
    expect(prompt).toContain('### Rule 19 — Point focus mode')
  })

  it('does NOT inject the layer manifest block when no manifest is passed', () => {
    expect(prompt).not.toContain('## Layer Manifest')
  })

  it('does NOT inject the manifest block for an empty manifest array', () => {
    expect(buildPrompt(AOI, 'en', undefined, [])).not.toContain('## Layer Manifest')
  })

  it('does NOT inject the point-focus block when no focus is passed', () => {
    // The `## POINT FOCUS MODE` header only appears in the focus block. (Rule 18
    // mentions the phrase in quotes, so we anchor on the markdown header + the
    // block-only "Clicked point:" line.)
    expect(prompt).not.toContain('## POINT FOCUS MODE')
    expect(prompt).not.toContain('Clicked point:')
  })

  it('respects the language label', () => {
    expect(buildPrompt(AOI, 'fr')).toContain('Français')
  })
})

describe('buildPrompt — point focus mode', () => {
  const focus: PointFocus = { lat: 51.5074, lng: -0.1278, kind: 'point' }
  const prompt = buildPrompt(AOI, 'en', focus)

  it('injects the POINT FOCUS MODE block with the exact coordinates', () => {
    expect(prompt).toContain('## POINT FOCUS MODE')
    expect(prompt).toContain('Clicked point:')
    expect(prompt).toContain('51.507400')
    expect(prompt).toContain('-0.127800')
  })

  it('tells the model to frame answers as "at the clicked point"', () => {
    expect(prompt).toContain('at the clicked point')
  })

  it('still contains the AOI section (drawn AOI is preserved as context)', () => {
    expect(prompt).toContain('## Area of Interest (AOI)')
  })

  it('biases toward point-friendly tools in the focus block', () => {
    expect(prompt).toContain('fetch_elevation_derivatives')
    expect(prompt).toContain('query_osm')
    expect(prompt).not.toContain('fetch_weather_realtime')
  })
})

describe('buildPrompt — identity, numbering and availability', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('names the product Erdfeld AI and never the old name', () => {
    expect(buildPrompt(AOI, 'en')).toContain('You are Erdfeld AI')
    expect(buildPrompt(AOI, 'en')).not.toMatch(/GeoAgent/)
  })

  it('numbers its rules without gaps or repeats', () => {
    for (const cv of ['0', '1']) {
      vi.stubEnv('GEOAGENT_ENABLE_CV', cv)
      const nums = [...buildPrompt(AOI, 'en').matchAll(/^### Rule (\d+) /gm)].map((m) => Number(m[1]))
      expect(nums).toEqual(nums.map((_, i) => i + 1))
    }
  })

  it('keeps the honesty rules: cannot determine, no invented values, resolution limits', () => {
    const p = buildPrompt(AOI, 'en')
    expect(p).toContain('cannot determine')
    expect(p).toContain('Never invent values')
    expect(p).toContain('quote it verbatim')
    expect(p).toContain('lower bounds')
  })

  it('has no shouting rhetoric', () => {
    expect(buildPrompt(AOI, 'en')).not.toMatch(/\b(NEVER|MANDATORY|MUST|CRITICAL|ALWAYS)\b/)
  })

  it('lists parked detectors only while the CV flag is on', () => {
    vi.stubEnv('GEOAGENT_ENABLE_CV', '0')
    const off = buildPrompt(AOI, 'en')
    for (const t of ['run_cv_detector', 'detect_objects', 'segment_feature']) expect(off).not.toContain(t)
    vi.stubEnv('GEOAGENT_ENABLE_CV', '1')
    const on = buildPrompt(AOI, 'en')
    for (const t of ['run_cv_detector', 'detect_objects', 'segment_feature']) expect(on).toContain(t)
  })
})

describe('buildPrompt — layer manifest (P4.4)', () => {
  const manifest: ManifestLayer[] = [
    {
      result_id: 'fetch_ndvi-0',
      tool: 'fetch_ndvi',
      name: 'NDVI Layer',
      provenance: { source: 'Sentinel-2 L2A', method: 'titiler NDVI', clip: 'bbox' },
      confidence: 'high',
      summary_data: { mean: 0.42, vegetation_pct: 64 },
    },
    {
      result_id: 'fetch_dem-0',
      tool: 'fetch_dem',
      name: 'DEM Layer',
      provenance: { source: 'SRTM 90m', method: 'opentopodata', clip: 'polygon' },
      confidence: 'medium',
      // no summary_data → should render the "no citable figures" hint
    },
  ]
  const prompt = buildPrompt(AOI, 'en', undefined, manifest)

  it('renders the manifest header', () => {
    expect(prompt).toContain('## Layer Manifest')
  })

  it('lists each layer with its result_id, name, source, and confidence', () => {
    expect(prompt).toContain('fetch_ndvi-0')
    expect(prompt).toContain('NDVI Layer')
    expect(prompt).toContain('Sentinel-2 L2A')
    expect(prompt).toContain('confidence: high')
    expect(prompt).toContain('fetch_dem-0')
    expect(prompt).toContain('confidence: medium')
  })

  it('renders the citable summary_data values for reuse', () => {
    expect(prompt).toContain('mean=0.42')
    expect(prompt).toContain('vegetation_pct=64')
  })

  it('flags a layer with no citable figures rather than omitting it', () => {
    expect(prompt).toContain('no citable figures')
  })

  it('renders array summary values compactly', () => {
    const arrManifest: ManifestLayer[] = [
      {
        result_id: 'classify_land_cover-0',
        tool: 'classify_land_cover',
        name: 'Land Cover',
        summary_data: {
          classes: [
            { label: 'Forest', value: 60 },
            { label: 'Urban', value: 40 },
          ],
        },
      },
    ]
    const p = buildPrompt(AOI, 'en', undefined, arrManifest)
    expect(p).toContain('classes=[Forest:60, Urban:40]')
  })

  it('coexists with point focus mode', () => {
    const focus: PointFocus = { lat: 51.5, lng: -0.12, kind: 'point' }
    const p = buildPrompt(AOI, 'en', focus, manifest)
    expect(p).toContain('## POINT FOCUS MODE')
    expect(p).toContain('## Layer Manifest')
  })
})
