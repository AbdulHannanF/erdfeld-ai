/** The perception pipeline — the four stages wired together (v2 spec §3.1).
 *
 *  ```
 *  request ─► ① Target Profile ─► ② Imagery Planner ─► ③ Detector Ladder ─► ④ Vectorize + Report
 *               (how big is it?)   (what resolves it?)   (A curated │ B open-vocab │ C indirect)
 *  ```
 *
 *  > Do not hard-code a pipeline per feature type. Build one perception pipeline
 *  > that plans itself from the request.
 *
 *  On the "LLM estimate" of stage ①: the agent calling this tool *is* the language
 *  model, so its estimate arrives as the `footprint_m` argument rather than
 *  costing a second round-trip inside the tool. The profiler keeps its `askLlm`
 *  seam for other callers and for tests.
 *
 *  Stage ④ is `describePerception` below. Every result states the tier that
 *  answered, the imagery source and its native resolution, AOI coverage, and —
 *  the part that matters most — what could not be resolved and what would.
 */

import { fetchTileImage } from '../cv'
import type { ToolCtx } from '../types'
import { profileTarget, type PerceptionTask, type TargetProfile } from './target-profile'
import { planImagery, type ImageryPlan } from './imagery-plan'
import { describeLadder, runDetectorLadder, type LadderContext, type LadderReport, type TierRunner } from './ladder'
import { makeTierARunner } from './tier-a'
import { makeTierBRunner } from './tier-b'
import { makeTierCRunner } from './tier-c'
import {
  hostedSegmentationAvailable,
  roboflowEmbedImage,
  roboflowEmbedTexts,
  roboflowSegment,
} from './backends'
import { registryFromEnv } from '../inference/model-registry'
import { currentModelProfile } from '../inference/profile'
import { runModel } from '../inference/adapters'

export interface PerceptionRequest {
  /** Natural-language target, e.g. "every car", "swimming pools". */
  target: string
  task?: PerceptionTask
  /** Caller-supplied footprint override, `[long, short]` metres. */
  footprintM?: [number, number]
  /** Skip Tier A and go straight to open vocabulary (diagnostics). */
  skipTierA?: boolean
}

export interface PerceptionResult {
  profile: TargetProfile
  plan: ImageryPlan
  ladder: LadderReport
}

/** Run the whole pipeline for one target over the AOI in `ctx`. */
export async function runPerception(ctx: ToolCtx, req: PerceptionRequest): Promise<PerceptionResult> {
  const task = req.task ?? 'detect'

  // ① Target profile.
  let profile = await profileTarget(req.target, { task })
  if (req.footprintM && profile.source !== 'curated') {
    const [a, b] = req.footprintM
    profile = {
      ...profile,
      footprintM: [Math.max(a, b), Math.min(a, b)],
      source: 'llm',
      confidence: 'low',
      note:
        `Footprint ${Math.max(a, b)} × ${Math.min(a, b)} m for "${profile.target}" was supplied by the ` +
        `agent, not measured — the resolution verdict below is only as good as that estimate.`,
    }
  }
  ctx.emit?.('token', {
    type: 'token',
    content:
      `Target "${profile.target}": ` +
      (profile.footprintM
        ? `${profile.footprintM[0]} × ${profile.footprintM[1]} m (${profile.source}), needs ≥${profile.minPxNeeded} px\n`
        : `size unknown — cannot judge what imagery would resolve it\n`),
  })

  // ② Imagery plan.
  const plan = await planImagery({
    lat: ctx.centroid.lat,
    lon: ctx.centroid.lng,
    footprintM: profile.footprintM?.[0] ?? null,
    minPx: profile.minPxNeeded,
    fetchTile: async (url) => Buffer.from(await fetchTileImage(url)),
  })
  ctx.emit?.('token', {
    type: 'token',
    content: plan.ok
      ? `Imagery: ${plan.source?.name} z${plan.zoom} — ${plan.mpp?.toFixed(2)} m/px, target ≈ ${plan.objectPx?.toFixed(0)} px\n`
      : `Imagery: cannot resolve this target here — ${plan.reason}\n`,
  })

  // ③ Detector ladder.
  const models = ctx.models ?? registryFromEnv(currentModelProfile())
  const ladderCtx: LadderContext = {
    profile, plan, aoi: ctx.aoi, bbox: ctx.bbox, areaKm2: ctx.areaKm2, emit: ctx.emit,
  }

  const runners: TierRunner[] = []
  if (!req.skipTierA) {
    runners.push(makeTierARunner({
      models,
      runModel,
      fetchTile: (url) => fetchTileImage(url),
    }))
  }
  runners.push(makeTierBRunner({
    segment: roboflowSegment,
    embedImage: roboflowEmbedImage,
    embedTexts: roboflowEmbedTexts,
    fetchTile: (url) => fetchTileImage(url),
    available: hostedSegmentationAvailable,
  }))
  runners.push(makeTierCRunner({}))

  const ladder = await runDetectorLadder(ladderCtx, runners)
  return { profile, plan, ladder }
}

// ---------------------------------------------------------------------------
// ④ Report
// ---------------------------------------------------------------------------

/** GeoJSON for the detections, coloured by confidence. */
export function perceptionGeoJson(result: PerceptionResult) {
  return {
    type: 'FeatureCollection',
    features: result.ladder.detections.map((d) => {
      const color = d.confidence > 0.7 ? '#22c55e' : d.confidence > 0.5 ? '#f59e0b' : '#ef4444'
      return {
        type: 'Feature',
        properties: {
          label: d.class,
          confidence: Math.round(d.confidence * 1000) / 1000,
          tier: d.tier,
          model: d.model,
          color,
          fill: color,
        },
        geometry: { type: 'Polygon', coordinates: d.polygon },
      }
    }),
  }
}

/**
 * Turn the pipeline state into prose the agent can quote.
 *
 * The rule the whole file exists to serve: a zero is only ever reported as "none
 * here" when a tier actually looked and could have seen them. Otherwise the
 * answer is "not resolvable / not attempted", plus what would change that.
 */
export function describePerception(result: PerceptionResult): string {
  const { profile, plan, ladder } = result
  const lines: string[] = []
  const n = ladder.detections.length

  if (n > 0) {
    const byClass = ladder.detections.reduce<Record<string, number>>((acc, d) => {
      acc[d.class] = (acc[d.class] ?? 0) + 1
      return acc
    }, {})
    lines.push(
      `**Found ${n} ${profile.target}${n === 1 ? '' : 's'}** ` +
        `(${Object.entries(byClass).map(([c, k]) => `${k} × ${c}`).join(', ')}) ` +
        `via Tier ${ladder.tierUsed}.`,
    )
  } else if (ladder.anyTierFailed) {
    lines.push(
      `**No answer — a detection stage failed.** This is not the same as "there are no ` +
        `${profile.target}s here": nothing successfully looked. See the ladder below.`,
    )
  } else if (!plan.ok) {
    lines.push(`**Cannot resolve "${profile.target}" here.** ${plan.reason}`)
    if (plan.wouldNeed) lines.push(`**What would work:** ${plan.wouldNeed}`)
  } else {
    lines.push(
      `**No ${profile.target}s detected.** Every stage that ran completed cleanly, so this is a ` +
        `real negative for the methods available — not a failure.`,
    )
  }

  lines.push('')
  lines.push(
    `**Target:** ${profile.footprintM
      ? `${profile.target}, ${profile.footprintM[0]} × ${profile.footprintM[1]} m (${profile.source} footprint), needs ≥${profile.minPxNeeded} px`
      : `${profile.target} — no physical size established`}`,
  )
  if (profile.note) lines.push(`_${profile.note}_`)

  if (plan.ok) {
    lines.push(
      `**Imagery:** ${plan.source?.name} at z${plan.zoom} — **${plan.mpp?.toFixed(2)} m/px**, ` +
        `so the target spans about **${plan.objectPx?.toFixed(0)} px**.`,
    )
  } else if (plan.ceilingZoom != null) {
    lines.push(
      `**Imagery ceiling here:** z${plan.ceilingZoom} (~${plan.ceilingMpp?.toFixed(2)} m/px). ` +
        `Finer zooms return the provider's blank placeholder tile.`,
    )
    if (plan.wouldNeed && n === 0 && ladder.anyTierFailed) lines.push(`**What would work:** ${plan.wouldNeed}`)
  }

  const coverage = ladder.coverage
  if (coverage) {
    lines.push(
      coverage.sampled
        ? `**Coverage:** ${coverage.analyzed}/${coverage.planned} image block(s) — ` +
          `~${coverage.coveragePct?.toFixed(0)}% of the AOI sampled, **not a full census**.`
        : `**Coverage:** ${coverage.analyzed}/${coverage.planned} image block(s) — full AOI at this resolution.`,
    )
  }

  lines.push('')
  lines.push('**Detector ladder:**')
  lines.push(describeLadder(ladder))
  return lines.join('\n')
}
