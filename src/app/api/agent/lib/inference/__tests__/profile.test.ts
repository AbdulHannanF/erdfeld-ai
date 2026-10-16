/**
 * MODEL_PROFILE resolution (spec §2).
 *
 * "Design for the 4090 box; degrade to the P1000. Every model entry declares a
 *  profile: tiny | base | large, and a MODEL_PROFILE env var (auto-detected from
 *  available VRAM, overridable) selects which weights load. `tiny` must run on
 *  4 GB and on CPU."
 *
 * Target box: 2× RTX 4090 = 48 GB VRAM → large.
 * Dev box:    Quadro P1000 = 4 GB VRAM  → tiny.
 */

import { describe, expect, it } from 'vitest'
import { profileForVram, resolveModelProfile, profileAllows, PROFILE_VRAM_GB } from '../profile'

describe('profileForVram — the two real machines', () => {
  it('picks large for the 2x RTX 4090 target box (48 GB)', () => {
    expect(profileForVram(48)).toBe('large')
  })

  it('picks tiny for the Quadro P1000 dev box (4 GB)', () => {
    expect(profileForVram(4)).toBe('tiny')
  })

  it('picks tiny with no GPU at all — tiny must run on CPU', () => {
    expect(profileForVram(0)).toBe('tiny')
    expect(profileForVram(null)).toBe('tiny')
  })

  it('is monotonic across the thresholds', () => {
    expect(profileForVram(PROFILE_VRAM_GB.base - 0.1)).toBe('tiny')
    expect(profileForVram(PROFILE_VRAM_GB.base)).toBe('base')
    expect(profileForVram(PROFILE_VRAM_GB.large - 0.1)).toBe('base')
    expect(profileForVram(PROFILE_VRAM_GB.large)).toBe('large')
    expect(profileForVram(128)).toBe('large')
  })

  it('never trusts a nonsensical reading into a larger profile', () => {
    expect(profileForVram(-5)).toBe('tiny')
    expect(profileForVram(NaN)).toBe('tiny')
  })
})

describe('resolveModelProfile — env override wins over detection', () => {
  it('honours an explicit MODEL_PROFILE', () => {
    expect(resolveModelProfile({ env: 'large', vramGb: 4 })).toBe('large')
    expect(resolveModelProfile({ env: 'tiny', vramGb: 48 })).toBe('tiny')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(resolveModelProfile({ env: '  LARGE ', vramGb: 0 })).toBe('large')
  })

  it('falls back to detection when the override is absent or unrecognised', () => {
    expect(resolveModelProfile({ env: undefined, vramGb: 48 })).toBe('large')
    expect(resolveModelProfile({ env: '', vramGb: 48 })).toBe('large')
    expect(resolveModelProfile({ env: 'enormous', vramGb: 4 })).toBe('tiny')
  })

  it('defaults to tiny when nothing is known — the safe direction', () => {
    expect(resolveModelProfile({})).toBe('tiny')
  })
})

describe('profileAllows — which models may load', () => {
  it('a box runs its own tier and everything lighter', () => {
    expect(profileAllows('large', 'tiny')).toBe(true)
    expect(profileAllows('large', 'base')).toBe(true)
    expect(profileAllows('large', 'large')).toBe(true)
    expect(profileAllows('base', 'tiny')).toBe(true)
    expect(profileAllows('base', 'base')).toBe(true)
    expect(profileAllows('tiny', 'tiny')).toBe(true)
  })

  it('refuses a model heavier than the box', () => {
    expect(profileAllows('tiny', 'base')).toBe(false)
    expect(profileAllows('tiny', 'large')).toBe(false)
    expect(profileAllows('base', 'large')).toBe(false)
  })
})
