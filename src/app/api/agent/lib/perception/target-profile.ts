/** ① Target profiler — natural language → physical footprint (v2 spec §3.2).
 *
 *  > Resolve any natural-language target to a physical footprint:
 *  > a small curated table of common targets; an LLM estimate for anything not in
 *  > the table, constrained to a plausible range; CLIP validation that the phrase
 *  > is visually meaningful at all.
 *
 *  This is the first stage of the perception pipeline and every later stage is
 *  derived from it: which imagery resolves the target, which detector can see it,
 *  and whether the question is answerable at all. A wrong footprint here becomes
 *  a confidently wrong answer three stages later, so the module is deliberately
 *  conservative — when it cannot establish a size it returns `null` and says so
 *  rather than picking a plausible-looking number.
 *
 *  Pure except for the injected `askLlm` / `visualCheck` callbacks, so the whole
 *  thing is unit-testable without a network.
 */

/** Pixels across the object's long axis needed to *detect* it.
 *
 *  The spec's range is 10–20 px; we take the conservative end. Individual
 *  detectors are stricter than this generic floor and declare their own
 *  requirement (`ModelSpec.minObjectPx`) — measured 2026-08-10, the DOTA-trained
 *  detector needs ~30–40 px and returns nothing at 18 px. The planner uses
 *  whichever requirement is higher.
 */
export const DETECTION_MIN_PX = 20

/** Segmentation tolerates less: a shape can be outlined before it is nameable. */
export const SEGMENTATION_MIN_PX = 8

/** Physically plausible bounds for anything a user can point at from orbit. */
const MIN_PLAUSIBLE_M = 0.05
const MAX_PLAUSIBLE_M = 1000

export type PerceptionTask = 'detect' | 'segment'

export interface CuratedTarget {
  /** `[long axis, short axis]` in metres. */
  footprintM: [number, number]
  /** Other phrasings that resolve here. */
  synonyms?: string[]
  /** Anything a report should say about this target's detectability. */
  note?: string
}

/**
 * Common targets with measured/consensus footprints, long axis first.
 *
 * Deliberately small. This table is a shortcut for the frequent cases, not the
 * vocabulary — anything absent goes to the LLM, which is what makes the pipeline
 * open-vocabulary rather than a fixed feature list.
 */
export const CURATED_TARGETS: Record<string, CuratedTarget> = {
  // "small vehicle" / "large vehicle" are DOTA's class names; carrying them as
  // synonyms is what lets a curated aerial detector answer the word a user
  // actually types.
  car:                { footprintM: [4.5, 2], synonyms: ['vehicle', 'automobile', 'auto', 'sedan', 'parked car', 'motor car', 'small vehicle'] },
  truck:              { footprintM: [8, 2.5], synonyms: ['lorry', 'hgv', 'semi', 'freight truck', 'large vehicle'] },
  bus:                { footprintM: [12, 2.5], synonyms: ['coach', 'minibus'] },
  motorcycle:         { footprintM: [2.2, 0.8], synonyms: ['motorbike', 'scooter'] },
  house:              { footprintM: [10, 10], synonyms: ['home', 'dwelling', 'residence', 'bungalow'] },
  building:           { footprintM: [20, 15], synonyms: ['structure', 'block'] },
  'informal structure': { footprintM: [5, 4], synonyms: ['shack', 'shanty', 'informal settlement structure'], note: 'Highly variable; small corrugated roofs are often below 5 m across.' },
  'swimming pool':    { footprintM: [8, 4], synonyms: ['pool', 'swimming-pool', 'lap pool'] },
  'solar panel':      { footprintM: [1.6, 1], synonyms: ['pv panel', 'photovoltaic panel', 'solar module'], note: 'A single module is ~1.6 m; arrays are far easier to resolve than individual panels.' },
  tree:               { footprintM: [6, 6], synonyms: ['tree crown', 'canopy', 'tree canopy'], note: 'Crown diameter varies from ~3 m (young/urban) to ~15 m (mature broadleaf).' },
  'utility pole':     { footprintM: [0.3, 0.3], synonyms: ['pole', 'telephone pole', 'power pole', 'lamp post', 'streetlight'], note: 'Sub-metre: effectively invisible from nadir at any public imagery resolution.' },
  boat:               { footprintM: [8, 3], synonyms: ['small boat', 'dinghy', 'yacht'] },
  ship:               { footprintM: [100, 20], synonyms: ['vessel', 'cargo ship', 'tanker'] },
  aircraft:           { footprintM: [40, 35], synonyms: ['airplane', 'plane', 'aeroplane', 'jet', 'airliner'] },
  helicopter:         { footprintM: [15, 12], synonyms: ['chopper'] },
  'storage tank':     { footprintM: [20, 20], synonyms: ['oil tank', 'tank', 'silo', 'grain silo'] },
  'shipping container': { footprintM: [12, 2.4], synonyms: ['container', 'sea container'] },
  'tennis court':     { footprintM: [24, 11], synonyms: ['tennis'] },
  'wind turbine':     { footprintM: [80, 80], synonyms: ['turbine', 'windmill'], note: 'Footprint is the rotor sweep; the tower base is only ~4 m.' },
  tent:               { footprintM: [4, 4], synonyms: ['shelter', 'camp tent'] },
  livestock:          { footprintM: [2.5, 1], synonyms: ['cattle', 'cow', 'sheep', 'animal'] },
}

/** Words that end in `s` but are already singular. */
const S_ENDING_SINGULARS = /(?:ss|us|is|ics|ous)$/

/** `-ses` words whose singular loses the whole "es" ("buses" → "bus"). */
const SES_PLURALS = new Set(['buses', 'gases', 'lenses', 'masses', 'trusses'])

/** Leading quantifiers/articles users type but that carry no meaning for size. */
const LEADING_NOISE = /^(?:find|show me|locate|detect|count|map(?: out)?|digitize|extract|delineate|trace)\s+/
const QUANTIFIERS = /^(?:every|all|any|each|some|the|a|an|of the|of)\s+/

/** Lower-case, de-quantify and singularise a target phrase. */
export function normalizeTargetPhrase(input: string): string {
  let s = String(input ?? '').trim().toLowerCase()
  s = s.replace(/[!?.,;:]+$/g, '').trim()
  s = s.replace(LEADING_NOISE, '').trim()
  // "all the cars", "each of the buildings" — strip repeatedly.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(QUANTIFIERS, '').trim()
    if (next === s) break
    s = next
  }
  if (!s) return ''

  const words = s.split(/\s+/)
  words[words.length - 1] = singularise(words[words.length - 1])
  return words.join(' ')
}

function singularise(word: string): string {
  if (word.length <= 2) return word
  if (S_ENDING_SINGULARS.test(word)) return word
  if (!word.endsWith('s')) return word

  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`

  // "churches", "bushes", "boxes", "glasses" — the singular really does end in
  // a sibilant, so the plural marker is the whole "es".
  if (/(?:ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2)

  // "-ses" is genuinely ambiguous in English: "buses" → "bus" but "houses" →
  // "house". Default to the commoner reading (strip only the s) and list the
  // exceptions, rather than guessing and turning "houses" into "hous".
  if (word.endsWith('ses')) {
    return SES_PLURALS.has(word) ? word.slice(0, -2) : word.slice(0, -1)
  }

  return word.slice(0, -1)
}

// ---------------------------------------------------------------------------
// Curated lookup
// ---------------------------------------------------------------------------

export interface CuratedHit extends CuratedTarget {
  /** Canonical key in `CURATED_TARGETS`. */
  key: string
}

/** Synonym → canonical key, built once. */
const SYNONYM_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [key, entry] of Object.entries(CURATED_TARGETS)) {
    m.set(key, key)
    for (const syn of entry.synonyms ?? []) m.set(syn, key)
  }
  return m
})()

/** Resolve a (already normalised or raw) phrase to a curated entry, or null. */
export function lookupCuratedTarget(phrase: string): CuratedHit | null {
  const norm = normalizeTargetPhrase(phrase)
  if (!norm) return null
  const key = SYNONYM_INDEX.get(norm)
  if (!key) return null
  return { key, ...CURATED_TARGETS[key] }
}

/** Generic pixel floor for a task. Detectors may demand more. */
export function minPixelsForTask(task: PerceptionTask): number {
  return task === 'segment' ? SEGMENTATION_MIN_PX : DETECTION_MIN_PX
}

// ---------------------------------------------------------------------------
// LLM estimate — treated as untrusted input
// ---------------------------------------------------------------------------

/**
 * Read a footprint out of an LLM answer.
 *
 * The model is asked for JSON but will sometimes wrap it in prose or a fence, so
 * we extract the first object rather than requiring a clean response. Everything
 * else is rejected: an implausible or unparseable answer must produce `null`, not
 * a number that looks like an answer.
 */
export function parseLlmFootprint(text: string): [number, number] | null {
  if (!text || typeof text !== 'string') return null
  const match = text.match(/\{[^{}]*\}/)
  if (!match) return null

  let obj: any
  try {
    obj = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const a = Number(obj.long_m ?? obj.length_m ?? obj.longM)
  const b = Number(obj.short_m ?? obj.width_m ?? obj.shortM)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null

  const long = Math.max(a, b)
  const short = Math.min(a, b)
  if (long < MIN_PLAUSIBLE_M || long > MAX_PLAUSIBLE_M) return null
  if (short < MIN_PLAUSIBLE_M || short > MAX_PLAUSIBLE_M) return null
  return [long, short]
}

/** Prompt used for the estimate. Exported so the tool layer and tests agree. */
export function footprintPrompt(phrase: string): string {
  return (
    `You are sizing an object for a satellite-imagery analysis. How large is a single "${phrase}" ` +
    `when viewed from directly overhead?\n\n` +
    `Reply with ONLY a JSON object: {"long_m": <number>, "short_m": <number>} — the long and short ` +
    `axes of its footprint in metres. If "${phrase}" is not a discrete physical object with a ` +
    `typical size, reply exactly: {"unknown": true}`
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type FootprintSource = 'curated' | 'llm' | 'unknown'

export interface TargetProfile {
  /** What the user typed, trimmed. */
  raw: string
  /** Normalised phrase used for lookup and for CLIP prompting. */
  target: string
  /** `[long, short]` in metres, or null when it could not be established. */
  footprintM: [number, number] | null
  /** Pixels across the long axis needed for the requested task. */
  minPxNeeded: number
  task: PerceptionTask
  source: FootprintSource
  confidence: 'high' | 'medium' | 'low'
  /** Honest note carried into the report. */
  note?: string
  /** CLIP self-similarity of the phrase against generic overhead language, when checked. */
  visualScore?: number
}

export interface ProfileTargetOptions {
  task?: PerceptionTask
  /** Injected LLM call; returns the raw completion text. */
  askLlm?: (prompt: string) => Promise<string>
  /** Optional CLIP check that the phrase means anything visually. */
  visualCheck?: (phrase: string) => Promise<number | null>
}

/**
 * Resolve a natural-language target to a physical profile.
 *
 * Order is curated → LLM → honest unknown. The curated table short-circuits the
 * LLM entirely, which keeps the common path free and deterministic.
 */
export async function profileTarget(
  phrase: string,
  opts: ProfileTargetOptions = {},
): Promise<TargetProfile> {
  const raw = String(phrase ?? '').trim()
  const task = opts.task ?? 'detect'
  const minPxNeeded = minPixelsForTask(task)
  const target = normalizeTargetPhrase(raw)

  const base = { raw, target, minPxNeeded, task }

  const curated = lookupCuratedTarget(target)
  if (curated) {
    return {
      ...base,
      footprintM: curated.footprintM,
      source: 'curated',
      confidence: 'high',
      ...(curated.note ? { note: curated.note } : {}),
      ...(await visualAnnotation(target, opts)),
    }
  }

  if (opts.askLlm && target) {
    let answer: string | null = null
    try {
      answer = await opts.askLlm(footprintPrompt(target))
    } catch {
      answer = null
    }
    const parsed = answer ? parseLlmFootprint(answer) : null
    if (parsed) {
      return {
        ...base,
        footprintM: parsed,
        source: 'llm',
        confidence: 'low',
        note:
          `Footprint for "${target}" (${parsed[0]} × ${parsed[1]} m) is a language-model estimate, ` +
          `not a measurement — treat the resolution verdict below as approximate.`,
        ...(await visualAnnotation(target, opts)),
      }
    }
  }

  return {
    ...base,
    footprintM: null,
    source: 'unknown',
    confidence: 'low',
    note:
      `Could not establish a physical size for "${target || raw}". It is not in the curated table ` +
      `and no usable estimate was available, so no claim is made about whether imagery can resolve it. ` +
      `Give an approximate size in metres and the analysis can proceed.`,
  }
}

async function visualAnnotation(
  target: string,
  opts: ProfileTargetOptions,
): Promise<{ visualScore?: number }> {
  if (!opts.visualCheck) return {}
  try {
    const score = await opts.visualCheck(target)
    return score == null ? {} : { visualScore: score }
  } catch {
    return {}
  }
}
