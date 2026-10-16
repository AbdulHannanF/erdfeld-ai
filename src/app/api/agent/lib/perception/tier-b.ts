/** Tier B — open vocabulary: SAM2 masks labelled by CLIP (v2 spec §3.4).
 *
 *  > Local SAM2 automatic mask generation over a point grid produces every object
 *  > in the tile; CLIP/SigLIP labels each mask against the user's phrase plus
 *  > distractor labels; masks clearing a margin threshold are kept. This is
 *  > viewpoint-agnostic — SAM2 segments shapes, not learned classes.
 *
 *  The design is the spec's. The *gate* is new, and comes from measuring it on
 *  2026-08-10 rather than assuming it works:
 *
 *  - Batched point prompts do work: 196 points over a 512 px mosaic returned 196
 *    predictions with real polygon rings in 4.9 s (hosted SAM2, one request).
 *    Many rings are 1–3 point noise contours and must be dropped.
 *  - CLIP labelling of the resulting masks did NOT work for cars at 0.25 m/px:
 *    19 of 83 candidates were labelled "car" and, looked at, were rooftops and
 *    bare ground — while the real cars had no mask on them at all.
 *  - On twelve hand-picked crops (7 verified cars, 5 verified non-cars) the
 *    car-vs-distractor margin was ≈0.02 against similarities of 0.25–0.35.
 *    Separable at a 24 px crop and at 96 px; NOT separable at 48 px.
 *
 *  Conclusion encoded below: CLIP carries real but weak signal that collapses on
 *  small objects, so Tier B refuses targets under `TIER_B_MIN_PX` and requires a
 *  margin over the best distractor. Without both, Tier B would answer every
 *  question — and a fallback that fires on every request is indistinguishable
 *  from a feature that works.
 */

import { getLogger } from '../logger'
import { dedupeDetections } from '../cv'
import { isPlaceholderTile } from './imagery-plan'
import {
  buildAoiMosaicGrid,
  composeMosaic as composeMosaicImpl,
  mosaicPixelToGeoPolygon,
  mosaicPixelToLonLat,
} from './mosaic'
import { clipDetectionsToAoi, type LadderContext, type PerceptionDetection, type TierRunner, type TierRunResult } from './ladder'

const log = getLogger('agent/perception-tier-b')

/**
 * Pixels across the target below which CLIP labelling is not trustworthy.
 *
 * Measured, not chosen: at ~40 px (a car at 0.11 m/px) real SAM2 masks produced
 * visibly wrong labels; hand-picked crops separated cleanly only once the crop
 * carried ~96 px of context. 64 is the conservative line between the two.
 */
export const TIER_B_MIN_PX = 64

/** Margin over the best distractor a mask must clear to be called a detection. */
export const TIER_B_MIN_MARGIN = 0.02

/** Points per side of the SAM2 prompt grid. */
const GRID_N = 14

/** Mosaics analysed per request — each is one segmentation call plus N CLIP calls. */
const MAX_MOSAICS = 2

/** Generic distractors, so "is this a car?" is a comparison and not a yes-man. */
const DISTRACTORS = ['a rooftop', 'a tree', 'bare ground', 'a road surface', 'water']

export function l2Normalize(v: number[]): number[] {
  let s = 0
  for (const a of v) s += a * a
  const n = Math.sqrt(s)
  return n > 0 ? v.map((a) => a / n) : v
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]
  return s
}

export interface MaskBox { x0: number; y0: number; x1: number; y1: number; w: number; h: number }

/** Bounding box of a polygon ring, or null when the ring is a noise contour. */
export function ringToBox(ring: number[][]): MaskBox | null {
  if (!Array.isArray(ring) || ring.length < 3) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue
    const [x, y] = p
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0) || !(h > 0)) return null
  return { x0, y0, x1, y1, w, h }
}

export interface LabelVerdict {
  label: string
  margin: number
  accepted: boolean
  similarity: number
}

/**
 * Decide what a crop is, given its similarity to [target, ...distractors].
 *
 * Accepts only when the target wins AND wins by more than `minMargin` — the
 * argmax alone was measured to be effectively random on small nadir crops.
 */
export function pickBestLabel(sims: number[], phrases: string[], minMargin: number): LabelVerdict {
  let bestIdx = 0
  for (let i = 1; i < sims.length; i++) if (sims[i] > sims[bestIdx]) bestIdx = i
  const best = sims[bestIdx]
  const bestDistractor = Math.max(...sims.filter((_, i) => i !== 0))
  const margin = sims[0] - bestDistractor
  return {
    label: phrases[bestIdx],
    similarity: best,
    margin,
    accepted: bestIdx === 0 && margin >= minMargin,
  }
}

export interface TierBDeps {
  /** Segment an image with a point grid; returns one ring list per prompt. */
  segment: (image: Buffer, points: Array<{ x: number; y: number }>) => Promise<number[][][]>
  /** Embed one image crop. */
  embedImage: (crop: Buffer) => Promise<number[] | null>
  /** Embed several phrases in one call (measured: text batches, images do not). */
  embedTexts: (texts: string[]) => Promise<number[][]>
  fetchTile: (url: string) => Promise<ArrayBuffer>
  /** Null when a backend is configured, else the reason it is not. */
  available: () => string | null
  composeMosaic?: typeof composeMosaicImpl
}

export function makeTierBRunner(deps: TierBDeps): TierRunner {
  const composeMosaic = deps.composeMosaic ?? composeMosaicImpl

  return {
    tier: 'B',
    name: 'open-vocabulary (SAM2 masks + CLIP labels)',

    gate(ctx: LadderContext): string | null {
      if (!ctx.plan.ok || ctx.plan.zoom == null) {
        return 'no imagery was planned that resolves this target, so there is nothing to segment.'
      }
      const unavailable = deps.available()
      if (unavailable) {
        return (
          `${unavailable}. Tier B needs a segmentation backend (hosted SAM2, or a local SAM2 + CLIP ` +
          `registered under Settings → Perception Models).`
        )
      }
      const objectPx = ctx.plan.objectPx ?? 0
      if (objectPx < TIER_B_MIN_PX) {
        return (
          `a ${ctx.profile.footprintM?.[0]} m ${ctx.profile.target} spans ${objectPx.toFixed(0)} px in the ` +
          `best imagery here, below the ${TIER_B_MIN_PX} px this tier needs. Measured 2026-08-10: on ` +
          `real masks at ~40 px, CLIP labelled rooftops and bare ground as cars while the actual cars ` +
          `went unmasked, and hand-picked crops separated by only ~0.02 of similarity. Running it here ` +
          `would produce confident nonsense rather than an answer.`
        )
      }
      return null
    },

    async run(ctx: LadderContext): Promise<TierRunResult> {
      const zoom = ctx.plan.zoom!
      const source = ctx.plan.source
      if (!source) return { error: 'the imagery plan carries no source to fetch tiles from.' }
      const sizePx = 512
      const grid = buildAoiMosaicGrid(ctx.aoi, ctx.bbox, { zoom, sizePx, maxMosaics: MAX_MOSAICS })

      const phrases = [`an overhead satellite photo of ${article(ctx.profile.target)}`,
        ...DISTRACTORS.map((d) => `an overhead satellite photo of ${d}`)]

      let textEmb: number[][]
      try {
        textEmb = (await deps.embedTexts(phrases)).map(l2Normalize)
      } catch (err: any) {
        return { error: `CLIP text embedding failed: ${err?.message ?? 'unknown'}.` }
      }
      if (textEmb.length !== phrases.length) {
        return { error: `CLIP returned ${textEmb.length} embeddings for ${phrases.length} phrases — cannot label reliably.` }
      }

      const sharp = (await import('sharp')).default
      const urlFor = (x: number, y: number, z: number) =>
        source.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))

      const raw: PerceptionDetection[] = []
      const failures: string[] = []
      let analyzed = 0
      let candidates = 0

      const points: Array<{ x: number; y: number }> = []
      for (let i = 0; i < GRID_N; i++) {
        for (let j = 0; j < GRID_N; j++) {
          points.push({
            x: Math.round(((j + 0.5) * sizePx) / GRID_N),
            y: Math.round(((i + 0.5) * sizePx) / GRID_N),
          })
        }
      }

      const expectedPx = (ctx.profile.footprintM?.[0] ?? 0) / (ctx.plan.mpp ?? 1)

      for (const mosaic of grid.mosaics) {
        const composed = await composeMosaic(mosaic, urlFor, deps.fetchTile, isPlaceholderTile)
        if ('error' in composed) { failures.push(composed.error); continue }

        let rings: number[][][]
        try {
          rings = await deps.segment(composed.image, points)
        } catch (err: any) {
          failures.push(`segmentation failed: ${err?.message ?? 'unknown'}`)
          continue
        }
        analyzed++

        // Footprint gate: keep only masks the size the target should be.
        const boxes = rings
          .map(ringToBox)
          .filter((b): b is MaskBox => {
            if (!b) return false
            const long = Math.max(b.w, b.h)
            return long >= expectedPx * 0.5 && long <= expectedPx * 2.5
          })
        candidates += boxes.length

        for (const b of boxes) {
          const pad = Math.round(Math.max(b.w, b.h) * 0.5)
          const left = Math.max(0, Math.round(b.x0) - pad)
          const top = Math.max(0, Math.round(b.y0) - pad)
          const width = Math.min(sizePx - left, Math.round(b.w) + pad * 2)
          const height = Math.min(sizePx - top, Math.round(b.h) + pad * 2)
          if (width < 8 || height < 8) continue

          let emb: number[] | null
          try {
            const crop = await sharp(composed.image)
              .extract({ left, top, width, height })
              .resize(224, 224, { fit: 'fill' })
              .png()
              .toBuffer()
            emb = await deps.embedImage(crop)
          } catch {
            continue
          }
          if (!emb) continue

          const e = l2Normalize(emb)
          const verdict = pickBestLabel(textEmb.map((t) => cosineSimilarity(e, t)), phrases, TIER_B_MIN_MARGIN)
          if (!verdict.accepted) continue

          const cx = (b.x0 + b.x1) / 2
          const cy = (b.y0 + b.y1) / 2
          raw.push({
            class: ctx.profile.target,
            // CLIP margin is not a probability. Reported as a bounded, honest
            // proxy so nothing downstream reads it as calibrated confidence.
            confidence: Math.min(0.75, 0.4 + verdict.margin * 5),
            centroid: mosaicPixelToLonLat(cx, cy, mosaic),
            polygon: mosaicPixelToGeoPolygon(cx, cy, b.w, b.h, mosaic),
            tier: 'B',
            model: 'sam2+clip',
          })
        }
      }

      if (analyzed === 0) {
        return {
          error:
            `Tier B could not analyse any of the ${grid.mosaics.length} image block(s). ` +
            `First error: ${failures[0] ?? 'unknown'}. This is a failure, not an empty result.`,
        }
      }

      const deduped = dedupeDetections(raw, Math.max(1.5, (ctx.profile.footprintM?.[1] ?? 3) * 0.75))
      const { kept: detections, dropped: outsideAoi } = clipDetectionsToAoi(deduped, ctx.aoi)
      log.info({ analyzed, candidates, kept: detections.length, outsideAoi }, 'tier B complete')

      return {
        detections,
        note:
          `segmented ${analyzed}/${grid.mosaics.length} block(s) with a ${GRID_N}×${GRID_N} point grid, ` +
          `${candidates} mask(s) matched the expected footprint, ${detections.length} cleared the ` +
          `${TIER_B_MIN_MARGIN} CLIP margin over ${DISTRACTORS.length} distractors. ` +
          `Open-vocabulary labelling is weaker than a curated detector — treat these as candidates.` +
          (outsideAoi > 0 ? ` ${outsideAoi} fell outside the drawn AOI and were discarded.` : '') +
          (failures.length ? ` ${failures.length} block(s) failed: ${failures[0]}` : ''),
        coverage: {
          analyzed, planned: grid.totalCandidates,
          sampled: grid.sampled || failures.length > 0,
          coveragePct: grid.totalCandidates ? (analyzed / grid.totalCandidates) * 100 : 100,
        },
      }
    },
  }
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`
}
