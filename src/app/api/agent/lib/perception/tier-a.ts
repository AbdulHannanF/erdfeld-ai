/** Tier A — curated aerial detector (v2 spec §3.4).
 *
 *  > Pinned, verified, aerial-trained weights when one matches the target. Local
 *  > ONNX preferred; Roboflow hosted as backup. Fast, accurate, narrow vocabulary.
 *
 *  Two things measured on 2026-08-10 are load-bearing here.
 *
 *  **Native resolution or nothing.** The same DOTA-trained detector produced
 *  misplaced boxes from a 512 px mosaic upscaled to its 1024 px input, and 7/7
 *  correct aircraft from a 1024 px mosaic built out of 16 native tiles. So Tier A
 *  builds mosaics at the model's own input size and tells the adapter to return
 *  coordinates in that space.
 *
 *  **The resolution floor is a gate, not a filter.** That detector finds vehicles
 *  where a car spans ~40 px and finds *nothing* where it spans ~18 px. Running it
 *  anyway below its floor and reporting the empty result would state "there are
 *  no cars here" when the truth is "this imagery cannot show cars". The gate is
 *  what keeps those two apart.
 */

import { getLogger } from '../logger'
import { dedupeDetections } from '../cv'
import type { ModelRegistry } from '../inference/model-registry'
import type { ModelSpec } from '../inference/model-spec'
import type { ModelRunInput, ModelRunResult } from '../inference/adapters'
import { DETECTION_MIN_PX, lookupCuratedTarget, normalizeTargetPhrase } from './target-profile'
import { isPlaceholderTile } from './imagery-plan'
import {
  buildAoiMosaicGrid,
  composeMosaic as composeMosaicImpl,
  mosaicPixelToGeoPolygon,
  mosaicPixelToLonLat,
  tilesPerSideFor,
  type MosaicSpec,
} from './mosaic'
import { clipDetectionsToAoi, type LadderContext, type PerceptionDetection, type TierRunner, type TierRunResult } from './ladder'

const log = getLogger('agent/perception-tier-a')

/** Mosaics analysed per request. Each is one model call over 16 tiles. */
const MAX_MOSAICS = 12

/**
 * Does a model's class name answer the user's word?
 *
 * Goes through the curated table so domain vocabulary lands on everyday words —
 * DOTA says "small vehicle", the user says "car". Substring matching is allowed
 * only on whole words, because "ground track field" shares no object with "car"
 * despite sharing letters.
 */
export function classMatchesTarget(className: string, target: string): boolean {
  const c = normalizeTargetPhrase(className)
  const t = normalizeTargetPhrase(target)
  if (!c || !t) return false
  if (c === t) return true

  const ck = lookupCuratedTarget(c)?.key
  const tk = lookupCuratedTarget(t)?.key
  if (ck && tk && ck === tk) return true

  // Whole-word containment ("parked car" ↔ "car"), never bare substring.
  const cw = c.split(/\s+/)
  const tw = t.split(/\s+/)
  if (tw.length > 1 && tw.every((w) => cw.includes(w))) return true
  if (cw.length > 1 && cw.every((w) => tw.includes(w))) return true
  return false
}

export interface CuratedMatch {
  spec: ModelSpec
  /** The model's own class names that answer this target. */
  matchedClasses: string[]
}

/**
 * Pick the registered detector whose vocabulary covers the target.
 *
 * Later-registered models win: a user who adds their own weights in Settings
 * expects them to take precedence over a shipped default.
 */
export function selectCuratedModel(models: ModelRegistry, target: string): CuratedMatch | null {
  const candidates = models.forTask('detect').reverse()
  for (const spec of candidates) {
    if (spec.targets?.some((t) => classMatchesTarget(t, target))) {
      const matched = (spec.classes ?? []).filter((c) => classMatchesTarget(c, target))
      return { spec, matchedClasses: matched.length ? matched : (spec.classes ?? []) }
    }
    const matched = (spec.classes ?? []).filter((c) => classMatchesTarget(c, target))
    if (matched.length) return { spec, matchedClasses: matched }
  }
  return null
}

export interface TierADeps {
  models: ModelRegistry
  runModel: (spec: ModelSpec, input: ModelRunInput) => Promise<ModelRunResult>
  fetchTile: (url: string) => Promise<ArrayBuffer>
  composeMosaic?: typeof composeMosaicImpl
}

export function makeTierARunner(deps: TierADeps): TierRunner {
  const composeMosaic = deps.composeMosaic ?? composeMosaicImpl

  return {
    tier: 'A',
    name: 'curated aerial detector',

    gate(ctx: LadderContext): string | null {
      if (!ctx.plan.ok || ctx.plan.zoom == null) {
        return (
          'no imagery was planned that resolves this target, so a detector could not be run ' +
          'against anything. See the imagery note above.'
        )
      }

      const registered = [...deps.models.models.values()].filter((m) => m.task === 'detect')
      if (registered.length === 0) {
        return (
          'no curated aerial detector is registered on this machine. Add one under ' +
          'Settings → Perception Models (any ONNX detector by URL or local path, or a Roboflow ' +
          'project) and this tier becomes available with no code change.'
        )
      }

      const match = selectCuratedModel(deps.models, ctx.profile.target)
      if (!match) {
        return (
          `no registered detector covers "${ctx.profile.target}". Registered detectors: ` +
          `${registered.map((m) => m.id).join(', ')}. Their vocabularies are narrow by design — ` +
          `a curated model is accurate precisely because it was trained on a fixed class list.`
        )
      }

      const floor = match.spec.minObjectPx ?? DETECTION_MIN_PX
      const objectPx = ctx.plan.objectPx ?? 0
      if (objectPx < floor) {
        return (
          `"${match.spec.id}" needs the target to span at least ${floor} px to see it, but a ` +
          `${ctx.profile.footprintM?.[0]} m ${ctx.profile.target} spans only ${objectPx.toFixed(0)} px ` +
          `at the best imagery available here (${ctx.plan.mpp?.toFixed(2)} m/px, z${ctx.plan.zoom}). ` +
          `Running it anyway would return zero, which reads as "none here" rather than ` +
          `"not visible at this resolution".`
        )
      }
      return null
    },

    async run(ctx: LadderContext): Promise<TierRunResult> {
      const match = selectCuratedModel(deps.models, ctx.profile.target)!
      const { spec } = match
      const zoom = ctx.plan.zoom!
      const source = ctx.plan.source!
      const sizePx = tilesPerSideFor(spec.inputSize) * 256

      const grid = buildAoiMosaicGrid(ctx.aoi, ctx.bbox, { zoom, sizePx, maxMosaics: MAX_MOSAICS })
      ctx.emit?.('token', {
        type: 'token',
        content:
          `Tier A [${spec.provider}:${spec.id}] — ${grid.mosaics.length} × ${sizePx}px mosaic(s) ` +
          `at z${zoom}${grid.sampled ? ` (sampled from ${grid.totalCandidates})` : ''}\n`,
      })

      const urlFor = (x: number, y: number, z: number) =>
        source.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))

      const raw: PerceptionDetection[] = []
      const failures: string[] = []
      let analyzed = 0

      for (const mosaic of grid.mosaics) {
        const composed = await composeMosaic(mosaic, urlFor, deps.fetchTile, isPlaceholderTile)
        if ('error' in composed) { failures.push(composed.error); continue }

        const out = await deps.runModel(spec, {
          imageBytes: composed.image,
          imagePx: sizePx,
          confidence: spec.defaultConfidence ?? 0.25,
        })
        if (!out.ok) { failures.push(out.error); continue }

        analyzed++
        for (const p of out.predictions) {
          if (!classMatchesTarget(p.class, ctx.profile.target)) continue
          raw.push(toDetection(p, mosaic, spec.id))
        }
      }

      // Every mosaic failing is a provider problem, not an empty scene.
      if (analyzed === 0) {
        return {
          error:
            `"${spec.id}" (${spec.provider}) could not analyse any of the ${grid.mosaics.length} ` +
            `image block(s). First error: ${failures[0] ?? 'unknown'}. No detections fabricated — ` +
            `this is a failure, not an empty result.`,
        }
      }

      // Dedupe across mosaic seams at roughly half the target's own footprint, so
      // two neighbouring cars stay two cars.
      const seamMeters = Math.max(1.5, (ctx.profile.footprintM?.[1] ?? 3) * 0.75)
      const deduped = dedupeDetections(raw, seamMeters)
      const { kept: detections, dropped: outsideAoi } = clipDetectionsToAoi(deduped, ctx.aoi)

      const coveragePct = grid.totalCandidates > 0 ? (analyzed / grid.totalCandidates) * 100 : 100
      const sampled = grid.sampled || failures.length > 0
      const partial = failures.length ? ` ${failures.length} block(s) failed: ${failures[0]}.` : ''
      const dupes = raw.length - deduped.length

      log.info({ model: spec.id, analyzed, planned: grid.mosaics.length, found: detections.length }, 'tier A complete')

      return {
        detections,
        note:
          `"${spec.id}" analysed ${analyzed}/${grid.mosaics.length} block(s) of ${sizePx}px at z${zoom} ` +
          `(${ctx.plan.mpp?.toFixed(2)} m/px, target ≈ ${ctx.plan.objectPx?.toFixed(0)} px), matching ` +
          `class(es) ${match.matchedClasses.join(', ') || '(all)'}` +
          `${dupes > 0 ? `, ${dupes} seam duplicate(s) merged` : ''}` +
          `${outsideAoi > 0 ? `, ${outsideAoi} outside the drawn AOI discarded` : ''}.${partial}`,
        coverage: { analyzed, planned: grid.totalCandidates, sampled, coveragePct },
      }
    },
  }
}

function toDetection(
  p: { class: string; confidence: number; x: number; y: number; width: number; height: number },
  mosaic: MosaicSpec,
  model: string,
): PerceptionDetection {
  return {
    class: p.class,
    confidence: p.confidence,
    centroid: mosaicPixelToLonLat(p.x, p.y, mosaic),
    polygon: mosaicPixelToGeoPolygon(p.x, p.y, p.width, p.height, mosaic),
    tier: 'A',
    model,
  }
}
