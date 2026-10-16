import type { CitableToolResult, CitationRef } from '@/lib/citations'
import { resolveCitation } from '@/lib/citations'
import type { GeoResult } from '@/lib/geo-result'
import type { MapLayer, ToolCallStatus } from '@/store/useStore'

/**
 * What the Answer tab says about a run, derived from the store and from the stored results.
 * Pure: no React, no fetching. Every sentence is built from a recorded value; when a value is
 * missing the figure is left out, never estimated.
 */

export type StepOutcome = 'running' | 'ok' | 'flagged' | 'refused' | 'failed' | 'no_data'

/** How a step ended. `failed` is a fetch or execution failure; `no_data` is a step that ran fine
 *  and found nothing. The two read differently and are never merged. */
export function stepOutcome(tc: ToolCallStatus, toolResults: Record<string, CitableToolResult>, layers: MapLayer[]): StepOutcome {
  if (tc.status === 'running') return 'running'
  if (tc.status === 'error') return tc.verdict?.status === 'refused' ? 'refused' : 'failed'
  if (tc.verdict?.status === 'flagged') return 'flagged'
  if (tc.verdict?.status === 'failed') return 'failed'
  if (tc.resultId) {
    const figures = toolResults[tc.resultId]?.summaryData
    const hasFigures = !!figures && Object.keys(figures).length > 0
    const hasLayer = layers.some((l) => l.resultId === tc.resultId)
    if (!hasFigures && !hasLayer) return 'no_data'
  }
  return 'ok'
}

export type RunState = 'running' | 'answered' | 'refused' | 'failed' | 'cannot_determine'

export interface RunSummary {
  state: RunState
  /** One line per step that did not produce usable evidence, with its recorded reason. */
  reasons: Array<{ label: string; outcome: StepOutcome; text: string }>
}

export function summariseRun(
  toolCalls: ToolCallStatus[],
  toolResults: Record<string, CitableToolResult>,
  layers: MapLayer[],
  isLoading: boolean,
): RunSummary {
  if (isLoading) return { state: 'running', reasons: [] }
  const outcomes = toolCalls.map((tc) => stepOutcome(tc, toolResults, layers))
  const reasons: RunSummary['reasons'] = []
  toolCalls.forEach((tc, i) => {
    const outcome = outcomes[i]
    if (outcome === 'refused' || outcome === 'failed' || outcome === 'no_data') {
      const checks = tc.verdict?.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')
      const fallback =
        outcome === 'no_data' ? 'The step ran and returned no data for this area and period.' : outcome === 'refused' ? 'The step was not run.' : 'The data could not be read.'
      reasons.push({ label: tc.label || tc.toolName, outcome, text: checks || tc.errorText || fallback })
    }
  })
  if (toolCalls.length === 0) return { state: 'answered', reasons }
  if (outcomes.some((o) => o === 'ok' || o === 'flagged')) return { state: 'answered', reasons }
  if (outcomes.every((o) => o === 'refused')) return { state: 'refused', reasons }
  if (outcomes.some((o) => o === 'failed') && !outcomes.some((o) => o === 'no_data')) return { state: 'failed', reasons }
  return { state: 'cannot_determine', reasons }
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const UNITS: Array<[RegExp, string]> = [
  [/_km2$/, ' km²'],
  [/_m2$/, ' m²'],
  [/_ha$/, ' ha'],
  [/_pct$/, '%'],
  [/_percent$/, '%'],
  [/_mm$/, ' mm'],
  [/_km$/, ' km'],
  [/_m$/, ' m'],
  [/_c$/, ' °C'],
  [/_days$/, ' days'],
]

/** "mean_elevation_m" -> "Mean elevation". The unit suffix is shown with the number instead. */
export function humanizeKey(key: string): string {
  let k = key
  for (const [re] of UNITS) k = k.replace(re, '')
  const s = k.replace(/_/g, ' ').trim().split(' ').map(acronym).join(' ')
  // Capitalise the first letter unless the label opens with a mixed-case acronym ("dNBR").
  return /^[a-z][A-Z]/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

/** Remote-sensing acronyms keep their case in labels ("mean_ndvi" -> "Mean NDVI"). */
const ACRONYMS: Record<string, string> = {
  ndvi: 'NDVI', ndwi: 'NDWI', mndwi: 'MNDWI', ndbi: 'NDBI', evi: 'EVI', savi: 'SAVI', nbr: 'NBR',
  dnbr: 'dNBR', sar: 'SAR', vv: 'VV', vh: 'VH', lst: 'LST', dem: 'DEM', aoi: 'AOI', swir: 'SWIR',
  nir: 'NIR', rgb: 'RGB', osm: 'OSM',
}
function acronym(word: string): string {
  return ACRONYMS[word.toLowerCase()] ?? word
}

/** Lower-cases a label for use mid-sentence, leaving acronyms alone. */
function lowerLabel(label: string): string {
  return label.split(' ').map((w) => (ACRONYMS[w.toLowerCase()] ? acronym(w) : w.toLowerCase())).join(' ')
}

export function unitOf(key: string): string {
  return UNITS.find(([re]) => re.test(key))?.[1] ?? ''
}

function num(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  const abs = Math.abs(v)
  return (abs >= 100 ? Math.round(v * 10) / 10 : abs >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000).toLocaleString('en-US')
}

export interface Figure {
  resultId: string
  key: string
  label: string
  /** The value with its unit, ready to print. */
  value: string
  range?: { low: string; high: string }
  confidence?: 'high' | 'medium' | 'low'
  /** A full sentence: "Mean elevation is 412 m (range 398 to 431 m)." */
  sentence: string
  /** The key counts things (`field_count`): its value already reads as "40 fields". */
  count?: boolean
}

/** The scalar figures a text cites, in order of first appearance, each with the range the result
 *  recorded for it (if any). Arrays are charted elsewhere, not written out. */
export function citedFigures(
  refs: CitationRef[],
  toolResults: Record<string, CitableToolResult>,
  details: Record<string, GeoResult | undefined>,
  max = 6,
): Figure[] {
  const seen = new Set<string>()
  const out: Figure[] = []
  for (const ref of refs) {
    const k = `${ref.resultId}#${ref.key}`
    if (seen.has(k)) continue
    seen.add(k)
    const r = resolveCitation(ref, toolResults)
    if (!r.resolved || r.value == null || Array.isArray(r.value)) continue
    const unit = typeof r.value === 'number' ? unitOf(ref.key) : ''
    const value = typeof r.value === 'number' ? `${num(r.value)}${unit}` : String(r.value)
    const rg = details[ref.resultId]?.uncertainty?.ranges?.[ref.key]
    const range = rg ? { low: `${num(rg[0])}${unit}`, high: `${num(rg[1])}${unit}` } : undefined
    const countNoun = typeof r.value === 'number' && Number.isInteger(r.value) ? ref.key.match(/^(?:[a-z0-9_]*_)?([a-z]+)_count$/)?.[1] : undefined
    const label = humanizeKey(ref.key)
    const shown = countNoun ? `${value} ${pluralise(r.value as number, countNoun)}` : value
    const sentence = countNoun ? `${label} is ${value}.` : `${label} is ${value}${range ? ` (range ${range.low} to ${range.high})` : ''}.`
    out.push({ resultId: ref.resultId, key: ref.key, label, value: shown, range, confidence: r.confidence, sentence, count: !!countNoun })
    if (out.length >= max) break
  }
  return out
}

/** "scene" + 3 -> "scenes". Only regular English plurals: the nouns come from our own result keys. */
export function pluralise(n: number, noun: string): string {
  if (n === 1) return noun
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The one result of the run that delineated fields, read by its field names, not by its text. */
function fieldResult(resultIds: string[], toolResults: Record<string, CitableToolResult>): CitableToolResult | null {
  for (const id of resultIds) {
    const d = toolResults[id]?.summaryData
    if (d && isNum(d.field_count) && Number.isInteger(d.field_count) && d.field_count >= 0) return toolResults[id]
  }
  return null
}

export interface RunHeadline {
  text: string
  /** A short noun for the figure when the text is a bare number; absent when the text says it all. */
  label?: string
  lowConfidence: boolean
}

/** The headline, from recorded fields only. For a field delineation it is
 *  "<count> <unit> · <area> of <class>", every part optional: the count alone when the area was not
 *  recorded, the area clause without "of <class>" when no dominant class was. Otherwise it is the
 *  first cited scalar, with its range. A low-confidence or ranged answer carries that in the
 *  headline itself, so the reader cannot take the bare number. Nothing recorded: no headline. */
/** Tools whose results describe the dataset catalogue rather than the area. */
const SEARCH_TOOLS = new Set(['find_dataset'])

export function runHeadline(
  figures: Figure[],
  resultIds: string[],
  toolResults: Record<string, CitableToolResult>,
): RunHeadline | null {
  const found = fieldResult(resultIds, toolResults)
  if (found) {
    const fields = found.summaryData
    const n = fields.field_count as number
    const parts = [`${num(n)} ${pluralise(n, 'field')}`]
    const area = fields.total_field_area_ha
    if (isNum(area) && n > 0) {
      const cls = typeof fields.dominant_class === 'string' && fields.dominant_class.trim() ? ` of ${fields.dominant_class.trim()}` : ''
      parts.push(`${num(area)} ha${cls}`)
    }
    return { text: parts.join(' · '), lowConfidence: found.confidence === 'low' }
  }
  // A search's hit count ("8 matches") describes the catalogue, not the place: never the headline.
  const f = figures.find((x) => !SEARCH_TOOLS.has(toolResults[x.resultId]?.tool ?? ''))
  if (!f) return null
  const lowConfidence = f.confidence === 'low'
  if (f.count) return { text: f.value, lowConfidence }
  const text = f.range ? `${f.value}, range ${f.range.low} to ${f.range.high}` : lowConfidence ? `${f.value}, low confidence` : f.value
  return { text, label: lowerLabel(f.label), lowConfidence }
}

/** Mean field size, pixel size and median confidence of a field delineation: only the ones the
 *  result recorded (a missing value is left out, never shown as 0). */
export function keyFigures(resultIds: string[], toolResults: Record<string, CitableToolResult>): Array<{ label: string; value: string }> {
  const d = fieldResult(resultIds, toolResults)?.summaryData
  if (!d) return []
  const out: Array<{ label: string; value: string }> = []
  if ((d.field_count as number) > 0 && isNum(d.mean_field_area_ha)) out.push({ label: 'Mean field size', value: `${num(d.mean_field_area_ha)} ha` })
  if (isNum(d.grid_gsd_m)) out.push({ label: 'Pixel size', value: `${num(d.grid_gsd_m)} m` })
  if ((d.field_count as number) > 0 && isNum(d.median_confidence)) out.push({ label: 'Median confidence', value: num(d.median_confidence) })
  return out
}

/** What the reader should know before relying on the answer: the notes the operations recorded,
 *  the validation checks that warned or failed, and low confidence. De-duplicated, capped. */
export function caveats(
  resultIds: string[],
  toolResults: Record<string, CitableToolResult>,
  details: Record<string, GeoResult | undefined>,
  max = 4,
): string[] {
  const out: string[] = []
  const add = (s: string | undefined) => {
    const t = s?.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  for (const id of resultIds) {
    const d = details[id]
    for (const n of d?.uncertainty?.notes ?? []) add(n)
    for (const c of d?.validation ?? []) if (c.status !== 'pass') add(c.message)
    if (toolResults[id]?.confidence === 'low') add(`${toolResults[id].tool.replace(/_/g, ' ')} has low confidence.`)
  }
  return out.slice(0, max)
}
