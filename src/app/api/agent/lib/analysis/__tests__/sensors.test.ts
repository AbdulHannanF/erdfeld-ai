/**
 * Phase 4 — sensor selection for a two-date comparison.
 *
 * The rule under test is the one that keeps an INSTRUMENT difference from being
 * reported as land-cover change. Measured 2026-08-16 over one Luxor polygon on
 * coincident clear days, Sentinel-2 vs Landsat NDVI: -0.107, -0.079, -0.021 —
 * not a constant, so no single coefficient removes it, and larger than most of
 * the multi-decade signals a change vector exists to find.
 */

import { describe, it, expect } from 'vitest'
import {
  SENSORS,
  indexBandNames,
  pickSensorForPair,
  sensorById,
  sensorSupportsIndex,
  isClearValue,
} from '../sensors'
import { SCL } from '../../cloud'

describe('the sensor registry', () => {
  it('is ordered finest-first and every entry can read NDVI', () => {
    expect(SENSORS.length).toBeGreaterThan(1)
    for (let i = 1; i < SENSORS.length; i++) {
      expect(SENSORS[i - 1].nativeResM).toBeLessThanOrEqual(SENSORS[i].nativeResM)
    }
    for (const s of SENSORS) expect(sensorSupportsIndex(s, 'NDVI')).toBe(true)
  })

  it('scales Landsat to surface reflectance and leaves Sentinel-2 as a ratio', () => {
    const ls = sensorById('landsat-c2-l2')!
    // C2 L2: DN * 0.0000275 - 0.2. The OFFSET is what matters — an index is a
    // ratio, so the scale cancels but the offset does not (0.157 vs 0.313).
    expect(ls.scale).toBeCloseTo(0.0000275, 10)
    expect(ls.offset).toBeCloseTo(-0.2, 10)
    const s2 = sensorById('sentinel-2-l2a')!
    expect(s2.offset).toBe(0)
  })

  it('maps canonical band names onto each sensor’s own asset keys', () => {
    expect(indexBandNames('NDVI')).toEqual(['nir', 'red'])
    expect(sensorById('landsat-c2-l2')!.bandAlias.nir).toBe('nir08')
    expect(sensorById('sentinel-2-l2a')!.bandAlias.nir).toBe('B08')
  })
})

describe('pickSensorForPair — ONE sensor must cover BOTH dates', () => {
  it('uses Sentinel-2 when both dates are inside its archive', () => {
    const r = pickSensorForPair('2020-06-01', '2024-06-01', 'NDVI')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sensor.id).toBe('sentinel-2-l2a')
    expect(r.sensor.nativeResM).toBe(10)
  })

  it('drops to Landsat for a pair that predates Sentinel-2, however recent the other date', () => {
    const r = pickSensorForPair('1990-07-01', '2024-07-01', 'NDVI')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The finer sensor cannot see 1990, so BOTH dates come from Landsat —
    // reading 2024 at 10 m and 1990 at 30 m would difference two instruments.
    expect(r.sensor.id).toBe('landsat-c2-l2')
    expect(r.reason).toMatch(/archive starts/i)
  })

  it('explains itself in terms of the earlier date, whichever order it is given', () => {
    const a = pickSensorForPair('2024-07-01', '1990-07-01', 'NDVI')
    const b = pickSensorForPair('1990-07-01', '2024-07-01', 'NDVI')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.sensor.id).toBe(b.sensor.id)
  })

  it('picks the boundary correctly right around Sentinel-2’s first acquisition', () => {
    const before = pickSensorForPair('2015-06-26', '2024-01-01', 'NDVI')
    const onOrAfter = pickSensorForPair('2015-06-27', '2024-01-01', 'NDVI')
    expect(before.ok && onOrAfter.ok).toBe(true)
    if (!before.ok || !onOrAfter.ok) return
    expect(before.sensor.id).toBe('landsat-c2-l2')
    expect(onOrAfter.sensor.id).toBe('sentinel-2-l2a')
  })

  it('refuses a date older than every archive instead of quietly using the closest one', () => {
    const r = pickSensorForPair('1970-01-01', '2024-01-01', 'NDVI')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/1982-08-22/)
    expect(r.message).toMatch(/deepest archive/i)
  })

  it('allows the pre-archive fallback only when explicitly asked', () => {
    const r = pickSensorForPair('1970-01-01', '2024-01-01', 'NDVI', { allowCrossSensor: true })
    expect(r.ok).toBe(true)
  })

  it('rejects a malformed date rather than guessing', () => {
    expect(pickSensorForPair('June 1990', '2024-01-01', 'NDVI').ok).toBe(false)
    expect(pickSensorForPair('2024', '2024-01-01', 'NDVI').ok).toBe(false)
  })

  it('rejects an index no sensor carries', () => {
    const r = pickSensorForPair('2020-01-01', '2024-01-01', 'NDXX')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/NDVI/)
  })
})

describe('isClearValue — each sensor read with its own quality vocabulary', () => {
  it('reads SCL classes for Sentinel-2', () => {
    expect(isClearValue('scl', SCL.VEGETATION)).toBe(true)
    expect(isClearValue('scl', SCL.WATER)).toBe(true)
    expect(isClearValue('scl', SCL.CLOUD_HIGH_PROB)).toBe(false)
    expect(isClearValue('scl', SCL.CLOUD_SHADOW)).toBe(false)
    expect(isClearValue('scl', SCL.NO_DATA)).toBe(false)
  })

  it('reads QA_PIXEL bit flags for Landsat', () => {
    const CLEAR = 1 << 6
    const CLOUD = (1 << 3) | (1 << 6)
    expect(isClearValue('landsat-qa', CLEAR)).toBe(true)
    expect(isClearValue('landsat-qa', CLOUD)).toBe(false)
    expect(isClearValue('landsat-qa', 0)).toBe(false)
  })

  it('does not read one sensor’s codes with the other’s vocabulary', () => {
    // SCL 9 is "cloud, high probability". As a QA_PIXEL bitmask 9 is
    // FILL|CLOUD — also not clear, but for a completely different reason.
    // The point is that the kind decides, never a shared magic number.
    expect(isClearValue('scl', 9)).toBe(false)
    expect(isClearValue('landsat-qa', 9)).toBe(false)
    // SCL 4 (vegetation) is clear; QA_PIXEL 4 has no CLEAR bit set at all.
    expect(isClearValue('scl', 4)).toBe(true)
    expect(isClearValue('landsat-qa', 4)).toBe(false)
  })
})
