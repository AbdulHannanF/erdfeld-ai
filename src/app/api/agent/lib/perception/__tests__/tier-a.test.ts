/** Tier A — curated aerial detector (spec §3.4).
 *
 *  > Pinned, verified, aerial-trained weights when one matches the target.
 *
 *  This is the only tier measured to work on small nadir objects, and the
 *  measurement that shapes it is the resolution floor: the DOTA-trained detector
 *  returns correct vehicles where a car spans ~40 px (Manhattan z20) and returns
 *  *nothing* where it spans ~18 px (Lahore z19). Reporting that blindness as
 *  "0 cars in this AOI" would be a false claim, so the floor is a gate, not a
 *  filter.
 */

import { describe, expect, it } from 'vitest'
import { classMatchesTarget, makeTierARunner, selectCuratedModel } from '../tier-a'
import type { LadderContext } from '../ladder'
import type { ModelRegistry } from '../../inference/model-registry'
import type { ModelSpec } from '../../inference/model-spec'

const DOTA: ModelSpec = {
  id: 'dota-obb', provider: 'local-onnx', ref: 'https://example/best.onnx', task: 'detect',
  classes: ['plane', 'ship', 'storage tank', 'baseball diamond', 'tennis court', 'basketball court',
    'ground track field', 'harbor', 'bridge', 'large vehicle', 'small vehicle', 'helicopter',
    'roundabout', 'soccer ball field', 'swimming pool'],
  inputSize: 1024, profile: 'tiny', minObjectPx: 32,
}

function registry(specs: ModelSpec[]): ModelRegistry {
  const models = new Map(specs.map((s) => [s.id, s]))
  return {
    models, skipped: [], errors: [],
    sourceOf: () => 'builtin',
    forTask: (t) => [...models.values()].filter((m) => m.task === t),
  }
}

function ctxWith(over: Partial<LadderContext> = {}): LadderContext {
  return {
    profile: {
      raw: 'every car', target: 'car', footprintM: [4.5, 2], minPxNeeded: 20,
      task: 'detect', source: 'curated', confidence: 'high',
    },
    plan: {
      ok: true, zoom: 20, mpp: 0.113, objectPx: 39.8, probes: [],
      source: { id: 'esri-world-imagery', name: 'Esri', urlTemplate: 'https://e/{z}/{y}/{x}', minZoom: 1, maxZoom: 23, bestResolutionM: 0.3, attribution: '', licence: '' },
    },
    aoi: { type: 'Polygon', coordinates: [[[-73.99, 40.75], [-73.98, 40.75], [-73.98, 40.76], [-73.99, 40.76], [-73.99, 40.75]]] },
    bbox: [-73.99, 40.75, -73.98, 40.76],
    areaKm2: 1,
    ...over,
  }
}

describe('classMatchesTarget', () => {
  it('matches a class name to the same word', () => {
    expect(classMatchesTarget('car', 'car')).toBe(true)
  })

  it('matches DOTA vocabulary onto everyday words via the curated table', () => {
    expect(classMatchesTarget('small vehicle', 'car')).toBe(true)
    expect(classMatchesTarget('large vehicle', 'truck')).toBe(true)
    expect(classMatchesTarget('plane', 'aircraft')).toBe(true)
  })

  it('does not match unrelated classes', () => {
    expect(classMatchesTarget('tennis court', 'car')).toBe(false)
    expect(classMatchesTarget('bridge', 'swimming pool')).toBe(false)
    expect(classMatchesTarget('harbor', 'house')).toBe(false)
  })

  it('is not fooled by a shared substring across different things', () => {
    // "ground track field" contains neither a car nor a truck.
    expect(classMatchesTarget('ground track field', 'car')).toBe(false)
  })
})

describe('selectCuratedModel', () => {
  it('finds the model whose vocabulary covers the target', () => {
    const hit = selectCuratedModel(registry([DOTA]), 'car')
    expect(hit?.spec.id).toBe('dota-obb')
    expect(hit?.matchedClasses).toEqual(['small vehicle'])
  })

  it('returns null when no registered model covers the target', () => {
    expect(selectCuratedModel(registry([DOTA]), 'giraffe')).toBeNull()
  })

  it('ignores models registered for another task', () => {
    const embed: ModelSpec = { ...DOTA, id: 'clip', task: 'embed', classes: ['car'] }
    expect(selectCuratedModel(registry([embed]), 'car')).toBeNull()
  })

  it('honours an explicit targets list even when class names differ', () => {
    const spec: ModelSpec = {
      id: 'panels', provider: 'roboflow', ref: 'a/1', task: 'detect',
      classes: ['pv'], targets: ['solar panel'], inputSize: 640, profile: 'tiny',
    }
    expect(selectCuratedModel(registry([spec]), 'solar panel')?.spec.id).toBe('panels')
  })
})

describe('Tier A runner — gating', () => {
  const deps = {
    models: registry([DOTA]),
    runModel: async () => ({ ok: true as const, predictions: [], provenance: 'x' }),
    fetchTile: async () => new ArrayBuffer(1000),
    composeMosaic: async () => ({ image: Buffer.alloc(10), placeholderTiles: 0, fetched: 16 }),
  }

  it('runs when the imagery resolves the target well enough for the model', () => {
    expect(makeTierARunner(deps).gate(ctxWith())).toBeNull()
  })

  it('skips — with numbers — when the object is below the model’s measured floor', () => {
    // Lahore z19: a car is 17.7 px against the model's declared 32 px floor.
    const gate = makeTierARunner(deps).gate(ctxWith({
      plan: { ok: true, zoom: 19, mpp: 0.2545, objectPx: 17.7, probes: [] },
    }))
    expect(gate).toBeTruthy()
    expect(gate).toContain('18')
    expect(gate).toContain('32')
    expect(gate).toMatch(/dota-obb/)
  })

  it('skips when no curated model covers the target, and says which are registered', () => {
    const gate = makeTierARunner(deps).gate(ctxWith({
      profile: { raw: 'giraffe', target: 'giraffe', footprintM: [5, 2], minPxNeeded: 20, task: 'detect', source: 'llm', confidence: 'low' },
    }))
    expect(gate).toMatch(/giraffe/)
    expect(gate).toMatch(/dota-obb/)
  })

  it('skips when the planner found no usable imagery', () => {
    const gate = makeTierARunner(deps).gate(ctxWith({ plan: { ok: false, probes: [], reason: 'ceiling z19' } }))
    expect(gate).toMatch(/imagery/i)
  })

  it('skips with an actionable message when nothing is registered at all', () => {
    const gate = makeTierARunner({ ...deps, models: registry([]) }).gate(ctxWith())
    expect(gate).toMatch(/no curated|not installed|none registered/i)
  })
})

describe('Tier A runner — execution', () => {
  const baseDeps = {
    models: registry([DOTA]),
    fetchTile: async () => new ArrayBuffer(1000),
    composeMosaic: async () => ({ image: Buffer.alloc(10), placeholderTiles: 0, fetched: 16 }),
  }

  it('georeferences predictions into the AOI and keeps only matching classes', async () => {
    const runner = makeTierARunner({
      ...baseDeps,
      runModel: async () => ({
        ok: true as const,
        provenance: 'local-onnx:dota-obb',
        predictions: [
          { class: 'small vehicle', confidence: 0.8, x: 100, y: 100, width: 40, height: 20 },
          { class: 'tennis court', confidence: 0.9, x: 300, y: 300, width: 80, height: 40 },
        ],
      }),
    })
    const out = await runner.run(ctxWith())
    expect('error' in out).toBe(false)
    if ('error' in out) return
    expect(out.detections.length).toBeGreaterThan(0)
    expect(out.detections.every((d) => d.class === 'small vehicle')).toBe(true)
    // Georeferenced near the AOI, not at null island.
    for (const d of out.detections) {
      expect(d.centroid[0]).toBeGreaterThan(-74.1)
      expect(d.centroid[0]).toBeLessThan(-73.9)
      expect(d.centroid[1]).toBeGreaterThan(40.7)
      expect(d.centroid[1]).toBeLessThan(40.8)
      expect(d.polygon[0]).toHaveLength(5)
    }
  })

  it('reports a provider failure as a FAILURE, never as zero detections', async () => {
    const runner = makeTierARunner({
      ...baseDeps,
      runModel: async () => ({ ok: false as const, error: 'HTTP 503 from provider' }),
    })
    const out = await runner.run(ctxWith())
    expect('error' in out).toBe(true)
    if (!('error' in out)) return
    expect(out.error).toContain('503')
  })

  it('reports a mosaic that could not be composed as a failure too', async () => {
    const runner = makeTierARunner({
      ...baseDeps,
      composeMosaic: async () => ({ error: 'all 16 tiles were the provider blank placeholder' }),
      runModel: async () => ({ ok: true as const, predictions: [], provenance: 'x' }),
    })
    const out = await runner.run(ctxWith())
    expect('error' in out).toBe(true)
    if (!('error' in out)) return
    expect(out.error).toMatch(/placeholder/)
  })

  it('returns a clean empty when the model ran and genuinely saw nothing', async () => {
    const runner = makeTierARunner({
      ...baseDeps,
      runModel: async () => ({ ok: true as const, predictions: [], provenance: 'x' }),
    })
    const out = await runner.run(ctxWith())
    expect('error' in out).toBe(false)
    if ('error' in out) return
    expect(out.detections).toHaveLength(0)
    expect(out.note).toMatch(/ran|analysed|analyzed/i)
  })

  it('sends the mosaic at the model input size, not a 256 px tile', async () => {
    let sawImagePx: number | undefined
    const runner = makeTierARunner({
      ...baseDeps,
      runModel: async (_s: any, input: any) => {
        sawImagePx = input.imagePx
        return { ok: true as const, predictions: [], provenance: 'x' }
      },
    })
    await runner.run(ctxWith())
    expect(sawImagePx).toBe(1024)
  })
})

describe('Tier A — AOI clipping', () => {
  it('drops detections outside the drawn polygon', async () => {
    // Mosaic blocks are tile-aligned, so at z20 a 1024 px block covers ~116 m and
    // overhangs a small AOI substantially. "Find every car in THIS AOI" must not
    // return cars from the next street over.
    const runner = makeTierARunner({
      models: registry([DOTA]),
      fetchTile: async () => new ArrayBuffer(1000),
      composeMosaic: async () => ({ image: Buffer.alloc(10), placeholderTiles: 0, fetched: 16 }),
      runModel: async () => ({
        ok: true as const,
        provenance: 'x',
        // Pixel 5,5 is the block's north-west corner — far outside a 0.01°-wide AOI
        // whose blocks start well north and west of it.
        predictions: [
          { class: 'small vehicle', confidence: 0.9, x: 5, y: 5, width: 20, height: 10 },
          { class: 'small vehicle', confidence: 0.9, x: 1019, y: 1019, width: 20, height: 10 },
        ],
      }),
    })
    const out = await runner.run(ctxWith())
    if ('error' in out) throw new Error(out.error)
    for (const d of out.detections) {
      expect(d.centroid[0]).toBeGreaterThanOrEqual(-73.99)
      expect(d.centroid[0]).toBeLessThanOrEqual(-73.98)
      expect(d.centroid[1]).toBeGreaterThanOrEqual(40.75)
      expect(d.centroid[1]).toBeLessThanOrEqual(40.76)
    }
  })
})
