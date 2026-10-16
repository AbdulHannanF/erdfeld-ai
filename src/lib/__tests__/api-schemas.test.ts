import { describe, expect, it } from 'vitest'

import { AgentRequestSchema, AoiSchema, GeoTileParamsSchema, ProjectCreateSchema, parseBody } from '../api-schemas'
import { apiErrorMessage } from '../api-errors'

const RING = [[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]
const POLY = { type: 'Polygon', coordinates: [RING] }
const feature = { type: 'Feature', properties: { a: 1 }, geometry: POLY }

describe('AoiSchema', () => {
  it('normalises a Feature and a one-feature FeatureCollection to the bare geometry', () => {
    expect(AoiSchema.parse(POLY)).toEqual(POLY)
    expect(AoiSchema.parse(feature)).toEqual(POLY)
    expect(AoiSchema.parse({ type: 'FeatureCollection', features: [feature] })).toEqual(POLY)
  })
  it('accepts a MultiPolygon', () => {
    const mp = { type: 'MultiPolygon', coordinates: [[RING]] }
    expect(AoiSchema.parse({ type: 'Feature', geometry: mp })).toEqual(mp)
  })
  it.each([
    ['a Point', { type: 'Point', coordinates: [1, 2] }],
    ['a LineString', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
    ['a short ring', { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }],
    ['a non-numeric coordinate', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 'x'], [0, 0]]] }],
    ['a latitude beyond 90', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 95], [0, 0]]] }],
    ['a Feature without geometry', { type: 'Feature', geometry: null }],
    ['an empty FeatureCollection', { type: 'FeatureCollection', features: [] }],
    ['a multi-feature FeatureCollection', { type: 'FeatureCollection', features: [feature, feature] }],
    ['null', null],
    ['a string', 'polygon'],
  ])('rejects %s', (_n, input) => {
    expect(AoiSchema.safeParse(input).success).toBe(false)
  })
})

describe('AgentRequestSchema', () => {
  const ok = { aoi: feature, query: 'How green is it?' }
  it('accepts a minimal request and unwraps the AOI', () => {
    expect(AgentRequestSchema.parse(ok).aoi).toEqual(POLY)
  })
  it.each([
    ['empty query', { ...ok, query: '   ' }],
    ['query over the cap', { ...ok, query: 'x'.repeat(4001) }],
    ['unknown provider', { ...ok, aiProvider: 'skynet' }],
    ['focus out of range', { ...ok, focus: { lat: 91, lng: 0 } }],
    ['layers not an array', { ...ok, layers: 'x' }],
    ['layer without result_id', { ...ok, layers: [{ tool: 'fetch_ndvi' }] }],
    ['non-string key', { ...ok, aiApiKey: 12 }],
    ['customModels of the wrong type', { ...ok, customModels: 5 }],
  ])('rejects %s', (_n, body) => {
    expect(AgentRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('other schemas', () => {
  it('requires something to save in a new project', () => {
    expect(ProjectCreateSchema.safeParse({}).success).toBe(false)
    expect(ProjectCreateSchema.safeParse({ name: 'x', messages: [{ id: '1', role: 'user', content: 'hi' }] }).success).toBe(true)
    expect(ProjectCreateSchema.safeParse({ layers: [{ id: 'l', name: 'n', type: 'bogus', opacity: 1, visible: true }] }).success).toBe(false)
  })
  it('keeps tile coordinates inside the zoom range', () => {
    const id = 'a'.repeat(24)
    expect(GeoTileParamsSchema.safeParse({ id, z: '3', x: '7', y: '0' }).success).toBe(true)
    expect(GeoTileParamsSchema.safeParse({ id, z: '3', x: '8', y: '0' }).success).toBe(false)
    expect(GeoTileParamsSchema.safeParse({ id, z: '25', x: '0', y: '0' }).success).toBe(false)
  })
  it('turns an invalid_request body into a readable message', () => {
    expect(apiErrorMessage({ error: 'invalid_request', issues: [{ path: 'query', message: 'the question is empty' }] }, 'x')).toBe('query: the question is empty')
    expect(apiErrorMessage({ error: 'rate_limited', message: 'Try again in 5 s.' }, 'x')).toBe('Try again in 5 s.')
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback')
  })
})

describe('parseBody', () => {
  const req = (body: BodyInit, headers: Record<string, string> = {}) => new Request('http://x/', { method: 'POST', body, headers })
  it('answers 413 over the cap, 400 for non-JSON, and field errors otherwise', async () => {
    const big = await parseBody(req('x'.repeat(100)), AoiSchema, { max: 10 })
    expect(!big.ok && big.response.status).toBe(413)
    const bad = await parseBody(req('{nope'), AoiSchema, { max: 1000 })
    expect(!bad.ok && bad.response.status).toBe(400)
    const wrong = await parseBody(req('{"type":"Point","coordinates":[1,2]}'), AoiSchema, { max: 1000 })
    expect(!wrong.ok && (await wrong.response.json()).error).toBe('invalid_request')
  })
  it('does not trust a Content-Length that is too small', async () => {
    const lying = await parseBody(req('x'.repeat(100), { 'content-length': '1' }), AoiSchema, { max: 10 })
    expect(!lying.ok && lying.response.status).toBe(413)
  })
})
