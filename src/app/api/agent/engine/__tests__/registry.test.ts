import { afterEach, describe, expect, it } from 'vitest'

import { getToolDefinitions, getOperation, labelFor, listOperations, registryJson, resolveOperation, typicalAreaLimitKm2 } from '../registry'

const CUT = [
  'query_flight_traffic', 'fetch_air_quality', 'fetch_weather_realtime', 'fetch_isochrone', 'query_route',
  'search_web', 'fetch_soil', 'generate_report', 'estimate_population', 'fetch_nighttime_lights',
]
const CV = ['run_cv_detector', 'detect_objects', 'segment_feature']

afterEach(() => {
  delete process.env.GEOAGENT_ENABLE_CV
  delete process.env.AGENT_ALLOW_STUB
})

describe('registry JSON: every operation states its full contract', () => {
  const ops = registryJson()

  it('lists the kept tools and none of the cut ones', () => {
    const names = ops.map((o) => o.name)
    for (const keep of ['fetch_ndvi', 'render_raster', 'map_flood', 'fetch_dem', 'query_osm', 'use_dataset', 'digitize_features']) expect(names).toContain(keep)
    for (const cut of CUT) expect(names).not.toContain(cut)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(ops.map((o) => [o.name, o] as const))('%s has params, limits, cost, limitations and a confidence meaning', (_n, o) => {
    expect(o.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(o.description.length).toBeGreaterThan(20)
    expect(o.params.type).toBe('object')
    expect(typeof o.params.properties).toBe('object')
    expect(['raster', 'vector', 'table', 'chart', 'text', 'mixed']).toContain(o.output)
    expect(o.limits.maxAreaKm2).toBeGreaterThan(0)
    expect(typeof o.limits.needsDates).toBe('boolean')
    expect(o.cost.typicalSeconds).toBeGreaterThan(0)
    expect(o.limitations.length).toBeGreaterThan(0)
    expect(o.confidence.length).toBeGreaterThan(10)
    expect(JSON.parse(JSON.stringify(o))).toEqual(o)
  })

  it('declares the date limits of the time-bound operations', () => {
    const by = Object.fromEntries(ops.map((o) => [o.name, o]))
    expect(by.map_flood.limits).toMatchObject({ needsDates: true, earliest: '2014-10-03', maxAreaKm2: 1600 })
    expect(by.render_raster.sensors).toEqual(['sentinel-2-l2a', 'landsat-c2-l2'])
  })
})

describe('parked CV detectors', () => {
  it('are absent unless GEOAGENT_ENABLE_CV=1, and present with it', () => {
    for (const n of CV) expect(getOperation(n)).toBeUndefined()
    expect(registryJson().map((o) => o.name)).not.toContain('detect_objects')
    process.env.GEOAGENT_ENABLE_CV = '1'
    for (const n of CV) expect(getOperation(n)).toBeDefined()
    expect(getToolDefinitions().map((t: any) => t.function.name)).toContain('detect_objects')
  })

  it('digitize_features stays and routes floods, fields and water without them', () => {
    expect(getOperation('digitize_features')).toBeDefined()
  })
})

describe('aliases, labels and the stub fixture', () => {
  it('resolves the legacy NDVI names to fetch_ndvi with the product', () => {
    expect(resolveOperation('render_ndvi_colormap', {})).toMatchObject({ op: { name: 'fetch_ndvi' }, args: { product: 'ndvi' } })
    expect(resolveOperation('fetch_high_res_imagery', {})).toMatchObject({ args: { product: 'imagery' } })
    expect(labelFor('fetch_high_res_imagery')).toBe('Fetching NDVI...')
    expect(labelFor('nonsense')).toBe('Running nonsense...')
  })

  it('render_to_map exists only with the stub flag and is never offered to the model', () => {
    expect(getOperation('render_to_map')).toBeUndefined()
    process.env.AGENT_ALLOW_STUB = '1'
    expect(getOperation('render_to_map')).toBeDefined()
    expect(getToolDefinitions().map((t: any) => t.function.name)).not.toContain('render_to_map')
    expect(listOperations().map((o) => o.name)).toContain('render_to_map')
  })
})

// Gemini's function-declaration schema is the narrowest of the supported providers.
function walk(node: any, path: string, problems: string[], isRoot = false) {
  if (!node || typeof node !== 'object') return
  for (const banned of ['$schema', '$ref', '$defs', 'definitions', 'additionalProperties', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'default', 'patternProperties', 'format']) {
    if (banned in node) problems.push(`${path}: uses ${banned}`)
  }
  if (Array.isArray(node.type)) problems.push(`${path}: type is an array`)
  if (node.type === 'object' && !isRoot && (!node.properties || Object.keys(node.properties).length === 0)) {
    problems.push(`${path}: nested object with no properties`)
  }
  if (node.enum && node.enum.some((v: unknown) => typeof v !== 'string')) problems.push(`${path}: non-string enum`)
  for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`, problems)
  if (node.items) walk(node.items, `${path}[]`, problems)
}

describe('every tool schema the model sees is portable across providers', () => {
  it('uses none of the constructs Gemini rejects, with CV on and off', () => {
    for (const cv of [false, true]) {
      if (cv) process.env.GEOAGENT_ENABLE_CV = '1'
      const problems: string[] = []
      for (const t of getToolDefinitions() as any[]) walk(t.function.parameters, t.function.name, problems, true)
      expect(problems).toEqual([])
    }
  })

  it('catches a violation (the walker is not vacuous)', () => {
    const problems: string[] = []
    walk({ type: 'object', properties: { a: { type: 'object' }, b: { anyOf: [] } } }, 't', problems, true)
    expect(problems).toHaveLength(2)
  })

  it('submit_plan carries step arguments as a JSON string', () => {
    const plan = (getToolDefinitions() as any[]).find((t) => t.function.name === 'submit_plan')
    const step = plan.function.parameters.properties.steps.items
    expect(step.properties.args_json.type).toBe('string')
    expect(step.properties.args).toBeUndefined()
    expect(step.required).toEqual(['tool', 'args_json', 'reason'])
  })

  it('make_chart takes its Vega-Lite spec as a JSON string', () => {
    const t = (getToolDefinitions() as any[]).find((x) => x.function.name === 'make_chart')
    expect(t.function.parameters.properties.spec.type).toBe('string')
  })
})

describe("typical area limit", () => {
  it("is the median of the operations' declared limits, so a ~200 km2 area is under it", () => {
    const limits = registryJson().map((o) => o.limits.maxAreaKm2).sort((a, b) => a - b)
    const mid = Math.floor(limits.length / 2)
    const median = limits.length % 2 ? limits[mid] : (limits[mid - 1] + limits[mid]) / 2
    expect(typicalAreaLimitKm2()).toBe(median)
    expect(typicalAreaLimitKm2()).toBeGreaterThan(200)
  })
})
