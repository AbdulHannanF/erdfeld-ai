/** ③ Detector ladder — orchestration (v2 spec §3.4).
 *
 *  > Tried in order; the first tier that returns a confident result wins, and the
 *  > report always states which tier answered.
 *
 *  **Tier A — curated aerial detector.** Pinned, aerial-trained weights when one
 *  matches the target. Narrow vocabulary, and the only tier measured to actually
 *  work on small nadir objects.
 *
 *  **Tier B — open vocabulary.** SAM2 masks labelled by CLIP. Unlimited
 *  vocabulary; measured reliable only for large objects (see `open-vocab.ts` for
 *  the numbers and the gate they imply).
 *
 *  **Tier C — indirect evidence.** For targets below nadir resolving power.
 *
 *  This file is pure orchestration so the tiers stay independently testable. Its
 *  entire job is the honesty bookkeeping:
 *
 *   - a tier that **failed** is never recorded as a tier that **found nothing**.
 *     "0 detections" after an HTTP 503 is indistinguishable from a model that
 *     genuinely found nothing, and the difference decides whether the user should
 *     believe the answer;
 *   - a skipped tier always carries the reason it was skipped;
 *   - the ladder — not the runner — stamps which tier produced each detection.
 */

import { pointInAoi } from '../geometry'
import type { TargetProfile } from './target-profile'
import type { ImageryPlan } from './imagery-plan'

export type LadderTier = 'A' | 'B' | 'C'

export interface PerceptionDetection {
  class: string
  confidence: number
  /** `[lon, lat]`. */
  centroid: [number, number]
  /** Closed ring(s). */
  polygon: number[][][]
  tier: LadderTier
  /** Model or method that produced it, for provenance. */
  model: string
}

export interface LadderContext {
  profile: TargetProfile
  plan: ImageryPlan
  aoi: any
  bbox: [number, number, number, number]
  areaKm2: number
  emit?: (event: string, data: any) => void
}

export type TierRunResult =
  | { detections: PerceptionDetection[]; note: string; coverage?: TierCoverage }
  | { error: string }

export interface TierCoverage {
  analyzed: number
  planned: number
  sampled: boolean
  coveragePct?: number
}

export interface TierRunner {
  tier: LadderTier
  name: string
  /** Return null to run, or a human-readable reason to skip. */
  gate(ctx: LadderContext): string | null
  run(ctx: LadderContext): Promise<TierRunResult>
}

export type TierStatus = 'answered' | 'empty' | 'skipped' | 'failed'

export interface TierOutcome {
  tier: LadderTier
  name: string
  status: TierStatus
  /** Never empty: what happened, or why it did not happen. */
  note: string
  detections: number
}

export interface LadderReport {
  detections: PerceptionDetection[]
  /** The tier that answered, or null when none did. */
  tierUsed: LadderTier | null
  outcomes: TierOutcome[]
  /** True when any tier errored — the answer is then "unknown", not "none". */
  anyTierFailed: boolean
  coverage?: TierCoverage
}

/**
 * Walk the ladder, stopping at the first tier that returns detections.
 *
 * A tier returning zero cleanly is a real result and the walk continues to the
 * next tier — a coarser method may still see what a finer one missed — but the
 * clean zero is preserved in `outcomes` so the report can distinguish "three
 * methods agree there are none here" from "nothing worked".
 */
export async function runDetectorLadder(
  ctx: LadderContext,
  runners: TierRunner[],
): Promise<LadderReport> {
  const outcomes: TierOutcome[] = []
  let anyTierFailed = false

  for (const runner of runners) {
    let skip: string | null = null
    try {
      skip = runner.gate(ctx)
    } catch (err: any) {
      skip = `tier gate errored: ${err?.message ?? 'unknown'}`
    }

    if (skip) {
      outcomes.push({ tier: runner.tier, name: runner.name, status: 'skipped', note: skip, detections: 0 })
      continue
    }

    let result: TierRunResult
    try {
      result = await runner.run(ctx)
    } catch (err: any) {
      result = { error: `${runner.name} threw: ${err?.message ?? 'unknown error'}` }
    }

    if ('error' in result) {
      anyTierFailed = true
      outcomes.push({ tier: runner.tier, name: runner.name, status: 'failed', note: result.error, detections: 0 })
      continue
    }

    // The ladder is the authority on provenance: a runner cannot mislabel which
    // tier produced a detection.
    const detections = result.detections.map((d) => ({ ...d, tier: runner.tier }))

    if (detections.length > 0) {
      outcomes.push({
        tier: runner.tier, name: runner.name, status: 'answered',
        note: result.note, detections: detections.length,
      })
      return { detections, tierUsed: runner.tier, outcomes, anyTierFailed, coverage: result.coverage }
    }

    outcomes.push({ tier: runner.tier, name: runner.name, status: 'empty', note: result.note, detections: 0 })
  }

  return { detections: [], tierUsed: null, outcomes, anyTierFailed }
}

/**
 * Keep only detections whose centroid falls inside the drawn AOI.
 *
 * Mosaic blocks are tile-aligned, so they overhang the AOI — at z20 a 1024 px
 * block spans ~116 m, which is most of a small AOI again. The user asked what is
 * in *this* polygon; returning objects from the next street over would inflate
 * every count with things they did not ask about.
 */
export function clipDetectionsToAoi(
  detections: PerceptionDetection[],
  aoi: any,
): { kept: PerceptionDetection[]; dropped: number } {
  const kept = detections.filter((d) => pointInAoi(d.centroid[0], d.centroid[1], aoi))
  return { kept, dropped: detections.length - kept.length }
}

/** One-line summary of what the ladder did, for the tool report. */
export function describeLadder(report: LadderReport): string {
  return report.outcomes
    .map((o) => {
      const label = `Tier ${o.tier} (${o.name})`
      switch (o.status) {
        case 'answered': return `${label}: **${o.detections} found** — ${o.note}`
        case 'empty':    return `${label}: ran, found none — ${o.note}`
        case 'skipped':  return `${label}: skipped — ${o.note}`
        case 'failed':   return `${label}: **failed** — ${o.note}`
      }
    })
    .join('\n')
}
