/** Target profiler (spec §3.2) — natural language → physical footprint.
 *
 *  The profiler is the first stage of the perception pipeline: everything
 *  downstream (which imagery resolves the target, which detector can see it,
 *  whether the answer is possible at all) is derived from the footprint. A wrong
 *  footprint here produces a confidently wrong answer three stages later, so the
 *  tests assert on VALUES, never on "it returned something".
 */

import { describe, expect, it } from 'vitest'
import {
  CURATED_TARGETS,
  DETECTION_MIN_PX,
  SEGMENTATION_MIN_PX,
  normalizeTargetPhrase,
  lookupCuratedTarget,
  minPixelsForTask,
  parseLlmFootprint,
  profileTarget,
} from '../target-profile'

describe('normalizeTargetPhrase', () => {
  it('strips the quantifiers users actually type', () => {
    expect(normalizeTargetPhrase('every car')).toBe('car')
    expect(normalizeTargetPhrase('all the cars')).toBe('car')
    expect(normalizeTargetPhrase('  Any Swimming Pools! ')).toBe('swimming pool')
    expect(normalizeTargetPhrase('each of the buildings')).toBe('building')
  })

  it('singularises regular and -es plurals without mangling singulars', () => {
    expect(normalizeTargetPhrase('houses')).toBe('house')
    expect(normalizeTargetPhrase('buses')).toBe('bus')
    expect(normalizeTargetPhrase('churches')).toBe('church')
    // "grass" and "bus" must not lose their final s.
    expect(normalizeTargetPhrase('grass')).toBe('grass')
    expect(normalizeTargetPhrase('bus')).toBe('bus')
  })

  it('keeps an unknown multi-word phrase intact', () => {
    expect(normalizeTargetPhrase('collapsed reinforced-concrete roof')).toBe('collapsed reinforced-concrete roof')
  })
})

describe('lookupCuratedTarget', () => {
  it('returns the measured footprint for a car, long axis first', () => {
    const hit = lookupCuratedTarget('car')
    expect(hit).not.toBeNull()
    expect(hit!.footprintM).toEqual([4.5, 2])
  })

  it('resolves synonyms to the same entry', () => {
    expect(lookupCuratedTarget('vehicle')?.key).toBe('car')
    expect(lookupCuratedTarget('automobile')?.key).toBe('car')
    expect(lookupCuratedTarget('pool')?.key).toBe('swimming pool')
  })

  it('does not invent an entry for an unknown noun', () => {
    expect(lookupCuratedTarget('quokka enclosure')).toBeNull()
  })

  it('every curated entry has a plausible, ordered footprint', () => {
    for (const [key, entry] of Object.entries(CURATED_TARGETS)) {
      const [long, short] = entry.footprintM
      expect(long, `${key} long axis`).toBeGreaterThan(0)
      expect(short, `${key} short axis`).toBeGreaterThan(0)
      expect(long, `${key} long >= short`).toBeGreaterThanOrEqual(short)
      expect(long, `${key} plausible`).toBeLessThan(1000)
    }
  })
})

describe('minPixelsForTask', () => {
  it('asks for more pixels to detect than to segment', () => {
    expect(minPixelsForTask('detect')).toBe(DETECTION_MIN_PX)
    expect(minPixelsForTask('segment')).toBe(SEGMENTATION_MIN_PX)
    expect(SEGMENTATION_MIN_PX).toBeLessThan(DETECTION_MIN_PX)
  })
})

describe('parseLlmFootprint — the LLM is untrusted input', () => {
  it('accepts a plausible two-number answer', () => {
    expect(parseLlmFootprint('{"long_m": 12, "short_m": 6}')).toEqual([12, 6])
  })

  it('reorders when the model puts the short axis first', () => {
    expect(parseLlmFootprint('{"long_m": 2, "short_m": 9}')).toEqual([9, 2])
  })

  it('rejects values outside the plausible physical range', () => {
    expect(parseLlmFootprint('{"long_m": 0.001, "short_m": 0.001}')).toBeNull()
    expect(parseLlmFootprint('{"long_m": 90000, "short_m": 4}')).toBeNull()
    expect(parseLlmFootprint('{"long_m": -3, "short_m": 1}')).toBeNull()
  })

  it('rejects prose, empty answers and NaN rather than guessing', () => {
    expect(parseLlmFootprint('about the size of a small car')).toBeNull()
    expect(parseLlmFootprint('')).toBeNull()
    expect(parseLlmFootprint('{"long_m": "big", "short_m": 2}')).toBeNull()
  })

  it('finds the object when the model wraps it in prose or a code fence', () => {
    expect(parseLlmFootprint('Sure!\n```json\n{"long_m": 30, "short_m": 10}\n```')).toEqual([30, 10])
  })
})

describe('profileTarget', () => {
  it('profiles a curated target without calling the LLM at all', async () => {
    let called = false
    const p = await profileTarget('find every car', {
      askLlm: async () => { called = true; return '{"long_m":99,"short_m":99}' },
    })
    expect(called).toBe(false)
    expect(p.source).toBe('curated')
    expect(p.target).toBe('car')
    expect(p.footprintM).toEqual([4.5, 2])
    expect(p.minPxNeeded).toBe(DETECTION_MIN_PX)
  })

  it('falls back to the LLM for a target no table could anticipate', async () => {
    const p = await profileTarget('cricket sightscreen', {
      askLlm: async () => '{"long_m": 12, "short_m": 12}',
    })
    expect(p.source).toBe('llm')
    expect(p.footprintM).toEqual([12, 12])
    expect(p.confidence).toBe('low')
  })

  it('says it does not know rather than inventing a size when the LLM is unusable', async () => {
    const p = await profileTarget('quokka enclosure', { askLlm: async () => 'no idea, sorry' })
    expect(p.source).toBe('unknown')
    expect(p.footprintM).toBeNull()
    expect(p.note).toMatch(/could not establish|unknown/i)
  })

  it('works with no LLM wired at all', async () => {
    const p = await profileTarget('swimming pool')
    expect(p.source).toBe('curated')
    expect(p.footprintM).toEqual([8, 4])
  })

  it('carries the raw phrase through so the report can quote the user', async () => {
    const p = await profileTarget('  ALL the Cars ')
    expect(p.raw).toBe('ALL the Cars')
    expect(p.target).toBe('car')
  })
})
