/** `inspect_imagery` — the agent looks at the AOI (Phase 2.5, spec §3.6 A).
 *
 *  The 2026-08-09 audit's decisive finding came from a human *looking* at a
 *  true-colour crop and recognising solid white cloud, while every tool in the
 *  stack reported that cloud top as vegetation health with a citation pill. The
 *  agent could not do that: it reasons over text summaries, in which a number
 *  from a cloud and a number from a field are indistinguishable.
 *
 *  This tool renders the AOI and asks a vision model what it sees, then puts
 *  that description NEXT TO the SCL cloud numbers for the same scene. Two
 *  independent readings of one acquisition: when they agree, the statistic is
 *  corroborated; when they disagree, that disagreement is the finding.
 *
 *  It never describes an image it did not obtain, and never describes one
 *  without a vision model — a description synthesised from statistics would be
 *  the agent inventing the picture it was asked to check.
 */

import { renderAoi, renderLabel, clarityLine, type RenderSubject } from '../lib/vision/render-aoi'
import { describeImage, resolveVlm } from '../lib/vision/vlm'
import { genId } from '../lib/geometry'
import { getLogger } from '../lib/logger'
import type { SummaryDatum, ToolCtx, ToolOutput } from '../lib/types'

const log = getLogger('agent/inspect-imagery')


/** The instruction the vision model receives. Deliberately asks for observation
 *  and explicitly licenses "I cannot tell" — a VLM pushed for a verdict will
 *  produce one, and a confident wrong reading is worse than an honest hedge
 *  (Roboflow's `aerial-airport/1` reported 11 aircraft at 99–100% with no box
 *  on an aircraft). */
function buildPrompt(label: string, question?: string): string {
  return [
    `You are looking at a satellite image: ${label}.`,
    'It is a nadir (straight-down) view. North is up. Areas outside the analysis polygon are transparent.',
    '',
    question
      ? `Question: ${question}`
      : 'Describe what is actually visible.',
    '',
    'Report, in at most 120 words:',
    '1. Whether cloud, haze, cloud shadow, snow or a sensor artefact covers any of the image, and roughly how much.',
    '2. The dominant land surfaces you can see (water, bare soil, vegetation, built-up, etc.).',
    '3. Anything that would make a numerical average of this area misleading.',
    '',
    'Describe only what is visible. If you cannot tell, say so — do not guess, and do not',
    'infer anything from what a place with these coordinates is usually like.',
  ].join('\n')
}

export async function inspectImagery(ctx: ToolCtx, args: Record<string, any>): Promise<ToolOutput> {
  const { aoi, bbox, emit, llm } = ctx

  const subject: RenderSubject = args.subject ?? 'truecolor'
  const question = args.question ? String(args.question) : undefined
  const sceneMode = args.scene === 'newest' ? 'newest' : 'clearest'

  // Resolve the backend BEFORE rendering: if nothing can look at the picture,
  // fetching it wastes a titiler call and the honest answer is the same.
  const vlm = await resolveVlm(llm)
  if (!vlm.ok) {
    return {
      summary: [
        `**No vision model is available, so the imagery was not inspected.**`,
        vlm.reason,
        `Every other tool still works — this only affects looking at the picture. ` +
          `The cloud numbers themselves come from Sentinel-2's SCL band and need no vision model: ` +
          `\`analyze_raster\` reports the clear fraction over your polygon on every call.`,
      ].join('\n\n'),
      failed: true, // nothing was looked at
    }
  }

  emit?.('token', {
    type: 'token',
    content: `Rendering the AOI (${subject === 'truecolor' ? 'true colour' : String(args.index || 'NDVI').toUpperCase()}) for visual inspection...\n`,
  })

  const rendered = await renderAoi({
    aoi, bbox, subject,
    index: args.index ? String(args.index) : undefined,
    date: args.date ? String(args.date) : undefined,
    scene: sceneMode,
    maxSize: args.max_size ? Number(args.max_size) : undefined,
  })
  if (!rendered.ok) return { summary: `Real data unavailable: ${rendered.message}` }
  const r = rendered.render
  const label = renderLabel(r)

  emit?.('token', {
    type: 'token',
    content: `Asking ${vlm.config.model} what is visible in the ${r.sceneDate} scene...\n`,
  })

  let described
  try {
    described = await describeImage({
      images: [r.imageBase64],
      prompt: buildPrompt(label, question),
      config: vlm.config,
    })
  } catch (err: any) {
    log.warn({ err: err?.message, model: vlm.config.model }, 'VLM inspection failed')
    return {
      summary: [
        `**The imagery was rendered but the vision model could not describe it.**`,
        String(err?.message ?? 'unknown error'),
        `The picture itself is real and is on the map as a layer — ${label}. ${clarityLine(r)}`,
      ].join('\n\n'),
      // The render succeeded, so the user still gets to look at it themselves.
      layer: {
        id: `inspect-${genId()}`,
        name: `${r.subject === 'truecolor' ? 'True colour' : r.index} — ${r.sceneDate}`,
        type: 'raster',
        imageBase64: r.imageBase64,
        bounds: bbox,
        confidence: 'high',
        provenance: {
          source: 'Sentinel-2 L2A (AWS Earth Search) via titiler /stac/feature.png',
          date: r.sceneDate,
          method: `${label}; not cloud-masked, so cloud is visible rather than removed`,
          clip: 'polygon',
        },
      },
    }
  }

  const clarity = r.clarity
  const summary_data: Record<string, SummaryDatum> = {
    subject: r.subject,
    scene_date: r.sceneDate,
    scene_id: r.sceneId,
    scene_selection: r.selection,
    aoi_coverage_pct: Number(r.coveragePct.toFixed(1)),
    vision_model: described.model,
    vision_backend: described.wire,
  }
  if (r.index) summary_data.index = r.index
  if (r.sceneCloudPct != null) summary_data.cloud_pct = Number(r.sceneCloudPct.toFixed(1))
  if (clarity) {
    summary_data.valid_pixel_pct = Number(clarity.clearPct.toFixed(1))
    summary_data.aoi_cloud_pct = Number(clarity.cloudPct.toFixed(1))
    summary_data.scl_breakdown = clarity.breakdown
      .slice(0, 6)
      .map((b) => ({ label: b.label, value: Number(b.pct.toFixed(1)) }))
  }

  // Lead with what was seen, then the number it is checked against, then the
  // caveat about what a VLM reading is and is not.
  const cross = clarity
    ? clarity.clearPct < 40
      ? `**The numbers agree that this scene is not usable**: ${clarityLine(r)} A statistic averaged over this ` +
        `acquisition would largely measure cloud, which is why the index tools refuse it.`
      : `**Cross-check:** ${clarityLine(r)} If the description above reports cloud the numbers do not, or ` +
        `vice versa, trust neither figure until the disagreement is resolved.`
    : `**Cross-check unavailable:** ${clarityLine(r)}`

  return {
    summary: [
      `**${described.model} looking at ${label}:**`,
      described.text,
      cross,
      `Read by ${described.model} via ${described.origin}. A vision model's reading is an observation, ` +
        `not a measurement — it is here to catch what the numbers cannot say (cloud, snow, artefact, ` +
        `scene context), not to replace them.`,
    ].join('\n\n'),
    summary_data,
    layer: {
      id: `inspect-${genId()}`,
      name: `${r.subject === 'truecolor' ? 'True colour' : r.index} — ${r.sceneDate}`,
      type: 'raster',
      imageBase64: r.imageBase64,
      bounds: bbox,
      confidence: 'high',
      provenance: {
        source: 'Sentinel-2 L2A (AWS Earth Search) via titiler /stac/feature.png',
        date: r.sceneDate,
        method:
          `${label}; scene chosen as the ${r.selection} in the ${r.windowLabel}; not cloud-masked, ` +
          `so cloud is visible rather than removed; described by ${described.model}`,
        clip: 'polygon',
      },
    },
  }
}
