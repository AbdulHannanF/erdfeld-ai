/** Shared fixtures for the reader tests: registry entries, AOIs, pixel grids and a routed fetch mock. */

import { vi } from 'vitest'
import type { PixelGrid } from '../../../pixels'
import type { DatasetEntry } from '../../types'
import type { ReaderAoi } from '../types'

export const RING = [[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]
export const AOI: ReaderAoi = {
  aoi: { type: 'Polygon', coordinates: [RING] },
  bbox: [74.05, 31.12, 74.08, 31.15],
  centroid: { lat: 31.135, lng: 74.065 },
  areaKm2: 9.52,
}
export const DENVER: ReaderAoi = {
  aoi: { type: 'Polygon', coordinates: [[[-104.995, 39.735], [-104.975, 39.735], [-104.975, 39.75], [-104.995, 39.75], [-104.995, 39.735]]] },
  bbox: [-104.995, 39.735, -104.975, 39.75],
  centroid: { lat: 39.7425, lng: -104.985 },
  areaKm2: 2.85,
}

export const PC = 'https://planetarycomputer.microsoft.com/api/stac/v1'

export function entry(over: Partial<DatasetEntry> & { collection?: string; root?: string } = {}): DatasetEntry {
  const root = over.root ?? PC
  const collection = over.collection ?? 'test-collection'
  const { collection: _c, root: _r, ...rest } = over
  return {
    id: `planetary-computer:${collection}`,
    title: `Test ${collection}`,
    description: '',
    source: 'planetary-computer',
    providers: ['Test'],
    themes: [],
    variables: [],
    spatial: { bbox: [-180, -90, 180, 90], global: true },
    temporal: { start: null, end: null },
    resolution_m: 10,
    license: 'CC-BY-4.0',
    access: { kind: 'stac-cog', url: `${root}/collections/${collection}`, requires_auth: null, notes: '' },
    keywords: [],
    ...rest,
  }
}

export const tiff = 'image/tiff; application=geotiff; profile=cloud-optimized'

export function item(id: string, over: { collection?: string; datetime?: string | null; assets?: string[]; props?: Record<string, any>; bbox?: number[] } = {}): any {
  const keys = over.assets ?? ['data']
  return {
    id,
    collection: over.collection ?? 'test-collection',
    bbox: over.bbox ?? [74, 31, 75, 32],
    properties: { datetime: over.datetime === undefined ? '2026-10-05T01:00:00Z' : over.datetime, ...(over.props ?? {}) },
    assets: {
      ...Object.fromEntries(keys.map((k) => [k, { href: `https://acct.blob.core.windows.net/c/${id}/${k}.tif`, type: tiff }])),
      tilejson: { href: 'https://x/tilejson.json', type: 'application/json' },
      rendered_preview: { href: 'https://x/preview.png', type: 'image/png' },
    },
  }
}

/** A polygon-clipped grid: `values` row-major; `valid` decides the mask (default all valid). */
export function grid(width: number, height: number, values: ArrayLike<number>, valid?: (i: number) => boolean, bands = 2): PixelGrid {
  const px = width * height
  const v = Float64Array.from({ length: px }, (_, i) => values[i % values.length])
  const mask = Float64Array.from({ length: px }, (_, i) => (valid ? (valid(i) ? 255 : 0) : 255))
  const raw = new Float64Array(px * bands)
  raw.set(v)
  raw.set(mask, (bands - 1) * px)
  return { values: v, mask, width, height, bands, raw }
}

type Route = { match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> }

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Install a global fetch that answers from `routes` and records every call. */
export function installFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    const route = routes.find((r) => r.match(url, init))
    if (!route) return new Response(`no mock for ${url}`, { status: 599 })
    return route.respond(url, init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

export const searchRoute = (features: any[], status = 200): Route => ({
  match: (u, i) => /\/search$/.test(u) && i?.method === 'POST',
  respond: () => (status === 200 ? json({ type: 'FeatureCollection', features }) : new Response('boom', { status })),
})

export const collectionRoute = (collection: any): Route => ({
  match: (u, i) => /\/collections\/[^/?]+$/.test(u) && (!i?.method || i.method === 'GET'),
  respond: () => json(collection),
})
