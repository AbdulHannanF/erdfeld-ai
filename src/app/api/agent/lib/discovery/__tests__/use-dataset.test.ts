/** Using an unwired dataset — the Phase 3 gate's second half.
 *
 *  Locating a collection is cheap; turning it into a real number over the drawn
 *  polygon is the gate. These cover the pure decisions on that path: which asset
 *  to read, where class names come from, and how counts become percentages.
 */

import { describe, expect, it } from 'vitest'
import {
  classCountsFromHistogram,
  classesFromCollection,
  pickRasterAsset,
} from '../use-dataset'

describe('pickRasterAsset', () => {
  it('prefers the data asset over the metadata ones PC ships with every item', () => {
    // Real asset set from io-lulc-annual-v02.
    const item = {
      assets: {
        data: { href: 'https://x/io.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized' },
        tilejson: { href: 'https://x/tilejson.json', type: 'application/json' },
        rendered_preview: { href: 'https://x/preview.png', type: 'image/png' },
      },
    }
    expect(pickRasterAsset(item)?.key).toBe('data')
  })

  it('never returns tilejson or a preview — reading one would measure a picture', () => {
    const item = {
      assets: {
        tilejson: { href: 'https://x/t.json', type: 'application/json' },
        rendered_preview: { href: 'https://x/p.png', type: 'image/png' },
      },
    }
    expect(pickRasterAsset(item)).toBeNull()
  })

  it('picks the classification band from a multi-asset land-cover item', () => {
    // Real asset set from esa-cci-lc.
    const item = {
      assets: {
        lccs_class: { href: 'https://x/lccs.tif', type: 'image/tiff' },
        change_count: { href: 'https://x/cc.tif', type: 'image/tiff' },
        observation_count: { href: 'https://x/oc.tif', type: 'image/tiff' },
        tilejson: { href: 'https://x/t.json', type: 'application/json' },
      },
    }
    expect(pickRasterAsset(item)?.key).toBe('lccs_class')
  })

  it('falls back to anything that declares itself a GeoTIFF', () => {
    const item = { assets: { weird_name: { href: 'https://x/a.tif', type: 'image/tiff; application=geotiff' } } }
    expect(pickRasterAsset(item)?.key).toBe('weird_name')
  })

  it('returns null when the item has no assets at all', () => {
    expect(pickRasterAsset({})).toBeNull()
    expect(pickRasterAsset({ assets: {} })).toBeNull()
  })
})

describe('classesFromCollection', () => {
  it('reads class names from the collection rather than hardcoding a vocabulary', () => {
    const collection = {
      id: 'io-lulc-annual-v02',
      item_assets: {
        data: {
          'classification:classes': [
            { value: 1, description: 'Water' },
            { value: 7, description: 'Built Area' },
            { value: 11, description: 'Rangeland' },
          ],
        },
      },
    }
    const classes = classesFromCollection(collection as any, 'data')
    expect(classes).toEqual([
      { value: 1, name: 'Water' },
      { value: 7, name: 'Built Area' },
      { value: 11, name: 'Rangeland' },
    ])
  })

  it('reads the STAC file extension too, which is what Planetary Computer actually uses', () => {
    // Real shape from io-lulc-annual-v02: `file:values`, not `classification:classes`.
    // Supporting only one extension silently produced "class 7" instead of
    // "Built Area" and dropped the categorical path entirely.
    const collection = {
      id: 'io-lulc-annual-v02',
      item_assets: {
        data: {
          'file:values': [
            { values: [0], summary: 'No Data' },
            { values: [1], summary: 'Water' },
            { values: [7], summary: 'Built Area' },
            { values: [11], summary: 'Rangeland' },
          ],
        },
      },
    }
    const classes = classesFromCollection(collection as any, 'data')
    expect(classes).toContainEqual({ value: 7, name: 'Built Area' })
    expect(classes).toContainEqual({ value: 11, name: 'Rangeland' })
  })

  it('expands a file:values entry that maps several values to one label', () => {
    const collection = {
      id: 'x',
      item_assets: { data: { 'file:values': [{ values: [2, 3, 4], summary: 'Vegetation' }] } },
    }
    const classes = classesFromCollection(collection as any, 'data')
    expect(classes).toEqual([
      { value: 2, name: 'Vegetation' },
      { value: 3, name: 'Vegetation' },
      { value: 4, name: 'Vegetation' },
    ])
  })

  it('returns null when the collection declares no classes, so the caller can say so', () => {
    expect(classesFromCollection({ id: 'cop-dem-glo-30' } as any, 'data')).toBeNull()
  })
})

describe('classCountsFromHistogram', () => {
  // The real histogram measured over the Lahore AOI on io-lulc-annual-v02.
  const HIST = [[90099, 639], [7, 11]]
  const CLASSES = [
    { value: 7, name: 'Built Area' },
    { value: 11, name: 'Rangeland' },
  ]

  it('turns titiler class counts into named percentages, largest first', () => {
    const rows = classCountsFromHistogram(HIST, CLASSES)
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Built Area')
    expect(rows[0].count).toBe(90099)
    expect(rows[0].pct).toBeCloseTo(99.3, 1)
    expect(rows[1].name).toBe('Rangeland')
  })

  it('reports raw class values honestly when no vocabulary is available', () => {
    const rows = classCountsFromHistogram(HIST, null)
    expect(rows[0].name).toBe('class 7')
    expect(rows[0].pct).toBeCloseTo(99.3, 1)
  })

  it('drops empty classes rather than listing zeroes', () => {
    const rows = classCountsFromHistogram([[5, 0, 3], [1, 2, 3]], null)
    expect(rows.map((r) => r.value)).toEqual([1, 3])
  })

  it('returns nothing for a missing or malformed histogram', () => {
    expect(classCountsFromHistogram(undefined, CLASSES)).toEqual([])
    expect(classCountsFromHistogram([[]], CLASSES)).toEqual([])
    expect(classCountsFromHistogram([[0, 0], [1, 2]], CLASSES)).toEqual([])
  })
})
