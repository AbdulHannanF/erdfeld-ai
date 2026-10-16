/** use_dataset: a categorical collection that declares its classes gets a class-colored
 *  tile layer (titiler `colormap`) with a categorical raster descriptor for the legend. */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/discovery/catalogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/discovery/catalogs')>()
  return { ...actual, fetchCollections: vi.fn() }
})
vi.mock('../../lib/discovery/use-dataset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/discovery/use-dataset')>()
  return { ...actual, readDatasetOverAoi: vi.fn() }
})

import { fetchCollections } from '../../lib/discovery/catalogs'
import { readDatasetOverAoi, categoricalStyle, classesFromCollection } from '../../lib/discovery/use-dataset'
import { useDataset as readDataset } from '../discovery'

const AOI = { type: 'Polygon', coordinates: [[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10.1], [10, 10]]] }
const ctx = (): any => ({ aoi: AOI, bbox: [10, 10, 10.1, 10.1], centroid: { lat: 10, lng: 10 }, areaKm2: 1, emit: vi.fn(), runTool: vi.fn() })

const WORLDCOVER = {
  id: 'esa-worldcover',
  title: 'ESA WorldCover',
  license: 'CC-BY-4.0',
  item_assets: {
    map: {
      'classification:classes': [
        { value: 10, description: 'Tree cover', color_hint: '006400' },
        { value: 40, description: 'Cropland', color_hint: 'f096ff' },
        { value: 50, description: 'Built-up', color_hint: 'fa0000' },
      ],
    },
  },
}

describe('classesFromCollection', () => {
  it('reads color_hint (with or without #) alongside the class name', () => {
    expect(classesFromCollection(WORLDCOVER as any, 'map')).toEqual([
      { value: 10, name: 'Tree cover', color: '#006400' },
      { value: 40, name: 'Cropland', color: '#f096ff' },
      { value: 50, name: 'Built-up', color: '#fa0000' },
    ])
  })
})

describe('categoricalStyle', () => {
  it('uses declared colors and reports that all colors are declared', () => {
    const declared = classesFromCollection(WORLDCOVER as any, 'map')
    const s = categoricalStyle(declared, [{ value: 40, name: 'Cropland' }, { value: 10, name: 'Tree cover' }])
    expect(s.allColorsDeclared).toBe(true)
    expect(s.colormap).toEqual({ '40': '#f096ff', '10': '#006400' })
    expect(s.classes.map((c) => c.label)).toEqual(['Cropland', 'Tree cover'])
  })

  it('assigns distinct palette colors to undeclared classes and flags it', () => {
    const s = categoricalStyle([{ value: 1, name: 'Water' }], [{ value: 1 }, { value: 2 }, { value: 3 }])
    expect(s.allColorsDeclared).toBe(false)
    expect(new Set(Object.values(s.colormap)).size).toBe(3)
    expect(s.classes[1].label).toBe('class 2')
  })
})

describe('use_dataset layer', () => {
  async function run(collection: any, categorical: boolean) {
    vi.mocked(fetchCollections).mockResolvedValue([collection])
    vi.mocked(readDatasetOverAoi).mockResolvedValue({
      ok: true,
      item: { properties: { datetime: '2021-01-01T00:00:00Z' } },
      asset: { key: 'map', href: 'https://x/map.tif' },
      signedHref: 'https://x/map.tif?sig=1',
      stats: { mean: 20 },
      classes: categorical
        ? [{ value: 40, name: 'Cropland', count: 80, pct: 80 }, { value: 10, name: 'Tree cover', count: 20, pct: 20 }]
        : [],
      categorical,
    } as any)
    return readDataset(ctx(), { catalog: 'planetary-computer', collection: collection.id })
  }

  it('categorical + declared classes: class colormap in the URL, categorical descriptor, AOI mask', async () => {
    const res = await run(WORLDCOVER, true)
    const layer = res.layer!
    const url = new URL(layer.tileUrl!.replace(/\{z\}|\{x\}|\{y\}/g, '0'))
    expect(JSON.parse(url.searchParams.get('colormap')!)).toEqual({ '40': '#f096ff', '10': '#006400' })
    expect(url.searchParams.has('rescale')).toBe(false)
    expect(layer.aoiMask).toBe(true)
    expect(layer.raster).toMatchObject({ kind: 'categorical', collection: 'esa-worldcover', datetime: '2021-01-01' })
    expect(layer.raster!.classes).toEqual([
      { value: 40, label: 'Cropland', color: '#f096ff' },
      { value: 10, label: 'Tree cover', color: '#006400' },
    ])
    expect(res.summary).not.toMatch(/assigned by GeoAgent/)
  })

  it('says so when the map colors are GeoAgent-assigned', async () => {
    const noColors = { ...WORLDCOVER, item_assets: { map: { 'classification:classes': [{ value: 10, description: 'Trees' }, { value: 40, description: 'Crops' }] } } }
    const res = await run(noColors, true)
    expect(res.summary).toMatch(/Map colors:\*\* assigned by GeoAgent/)
    expect(res.layer!.raster!.classes).toHaveLength(2)
  })

  it('continuous datasets keep the plain rescale tile and carry no raster descriptor', async () => {
    const res = await run({ id: 'cop-dem', title: 'DEM' }, false)
    expect(res.layer!.tileUrl).toContain('rescale=')
    expect(res.layer!.raster).toBeUndefined()
    expect(res.layer!.aoiMask).toBeUndefined()
  })
})
