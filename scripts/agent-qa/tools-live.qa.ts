/**
 * PHASE B — the data layer, tested without the LLM in the way.
 *
 * Every probe calls the REAL `executeTool` against REAL upstream endpoints. No
 * model is involved, so a failure here is unambiguously a data/tool defect and
 * never "the agent picked the wrong tool".
 *
 * Results stream to qa-out/tools.jsonl as they complete — a hung upstream at
 * probe 40 must not cost us probes 1-39.
 *
 * Run: npx vitest run --config scripts/agent-qa/vitest.qa.config.mts
 */
import fs from 'fs'
import path from 'path'
import { it, expect } from 'vitest'
import { executeTool } from '@/app/api/agent/tools/index'
 
import { AOIS, TOOL_PROBES } from './probes.mjs'

const OUT = path.resolve(process.cwd(), 'qa-out')
fs.mkdirSync(OUT, { recursive: true })
const JSONL = path.join(OUT, 'tools.jsonl')

const PROBE_TIMEOUT_MS = Number(process.env.QA_PROBE_TIMEOUT_MS || 180_000)

/** Deterministic red flags — things that are wrong regardless of what a judge thinks. */
function mechanicalChecks(summary: string, result: any) {
  const flags: string[] = []
  const s = summary || ''
  const low = s.toLowerCase()

  if (!s.trim()) flags.push('EMPTY_SUMMARY')
  if (/\bNaN\b/.test(s)) flags.push('NAN_IN_SUMMARY')
  if (/\bundefined\b/.test(s)) flags.push('UNDEFINED_IN_SUMMARY')
  if (/:\s*null\b/.test(s)) flags.push('NULL_IN_SUMMARY')
  if (/\bundetermined\b/i.test(s)) flags.push('UNDETERMINED')

  // The "0 results after an error" trap: a zero with no stated reason is
  // indistinguishable from a silent failure.
  const zeroClaim = /\b(0|no|zero)\s+(results?|features?|detections?|objects?|items?|matches)\b/i.test(s)
  const hasReason = /(unavailable|not configured|no api key|missing|error|failed|could not|cannot|timed out|does not|none found in|no data|outside|empty)/i.test(low)
  if (zeroClaim && !hasReason) flags.push('BARE_ZERO_NO_REASON')

  // Provenance is the backbone of the honesty claim; a layer without it is a defect.
  const layers = [result?.layer, ...(result?.layers || [])].filter(Boolean)
  for (const l of layers) {
    if (!l?.provenance?.source) flags.push('LAYER_WITHOUT_PROVENANCE')
  }

  // Range sanity on values we can bound from physics alone.
  for (const [k, v] of Object.entries<any>(result?.summary_data || {})) {
    const num = typeof v === 'number' ? v : typeof v?.value === 'number' ? v.value : null
    if (num === null || !Number.isFinite(num)) continue
    const key = k.toLowerCase()
    if (/(ndvi|ndwi|ndbi|nbr|evi|savi|index)/.test(key) && !/count|pixels|area|_m|percent|pct/.test(key)) {
      if (num < -1.001 || num > 1.001) flags.push(`INDEX_OUT_OF_RANGE:${k}=${num}`)
    }
    if (/(percent|pct|_pc$|coverage|fraction_pct)/.test(key) && (num < -0.01 || num > 100.01)) {
      flags.push(`PERCENT_OUT_OF_RANGE:${k}=${num}`)
    }
    if (/(temp|_c$|celsius|lst)/.test(key) && /c$|temp|lst/.test(key) && (num < -95 || num > 90)) {
      flags.push(`TEMPERATURE_IMPLAUSIBLE:${k}=${num}`)
    }
  }
  return flags
}

/** Trim a ToolOutput down to what the judge and the report actually need. */
function condense(result: any) {
  const layers = [result?.layer, ...(result?.layers || [])].filter(Boolean)
  return {
    summary: String(result?.summary ?? ''),
    summary_data: Object.fromEntries(
      Object.entries<any>(result?.summary_data || {}).slice(0, 24).map(([k, v]) => {
        const val = v && typeof v === 'object' && 'value' in v ? v.value : v
        const short = Array.isArray(val) ? `[array:${val.length}] ${JSON.stringify(val.slice(0, 4))}` : val
        return [k, short]
      }),
    ),
    layers: layers.slice(0, 4).map((l: any) => ({
      type: l?.type,
      name: l?.name,
      provenance: l?.provenance,
      confidence: l?.confidence,
      features: l?.data?.features?.length ?? l?.geojson?.features?.length ?? undefined,
    })),
  }
}

it('phase B — live tool sweep', async () => {
  fs.writeFileSync(JSONL, '')
  const started = Date.now()
  let n = 0

  for (const probe of TOOL_PROBES as any[]) {
    n++
    const aoi = AOIS[probe.aoi]
    const t0 = Date.now()
    let record: any

    try {
      const result = await Promise.race([
        executeTool(probe.tool, aoi.geom, probe.args),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
        ),
      ])
      const condensed = condense(result)
      record = {
        ...probe,
        aoi_label: aoi.label,
        ms: Date.now() - t0,
        threw: false,
        ...condensed,
        flags: mechanicalChecks(condensed.summary, result),
      }
    } catch (err: any) {
      record = {
        ...probe,
        aoi_label: aoi.label,
        ms: Date.now() - t0,
        threw: true,
        error: String(err?.message || err).slice(0, 500),
        summary: '',
        summary_data: {},
        layers: [],
        flags: ['THREW'],
      }
    }

    fs.appendFileSync(JSONL, JSON.stringify(record) + '\n')
    const mark = record.threw ? 'THREW' : record.flags.length ? `FLAG(${record.flags.length})` : 'ok'
    console.log(
      `[${String(n).padStart(2)}/${TOOL_PROBES.length}] ${mark.padEnd(9)} ${probe.id.padEnd(22)} ` +
      `${probe.tool.padEnd(28)} ${(record.ms / 1000).toFixed(1)}s`,
    )
  }

  console.log(`phase B done in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min → ${JSONL}`)
  expect(fs.readFileSync(JSONL, 'utf8').trim().split('\n').length).toBe(TOOL_PROBES.length)
})
