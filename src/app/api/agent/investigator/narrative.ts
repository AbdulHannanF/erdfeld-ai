/**
 * The dossier narrative. The model writes it from recorded results only; this module checks it.
 *
 * Rule: every sentence with a number cites `[[result_id#field]]`, every citation names a recorded
 * result and a field it really has, and every number in the sentence is one of the cited values
 * (rounded). A sentence that breaks the rule is removed, not repaired, so nothing unsupported
 * reaches the reader. When the model is unavailable, or nothing survives, the narrative is built
 * from the recorded results directly.
 */

import type { NarrativeRecord } from './llm'

export type CitableIndex = Map<string, Record<string, number | string>>

const CITATION = /\[\[(r_[0-9a-f]{16}|[A-Za-z0-9_]+-\d+)#([A-Za-z0-9_]+)\]\]/g

/** Strip dates and years: they are not measurements. */
const stripDates = (s: string) => s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ')

/** Sentences and the whitespace between them. A full stop ends a sentence only before whitespace or the end, so 12.3 stays whole. */
const splitSentences = (text: string): string[] => text.match(/(?:[^.!?\n]|[.!?](?=\S))+(?:[.!?]+(?=\s|$))?|\s+/g) ?? []

const decimals = (s: string) => (s.includes('.') ? s.split('.')[1].length : 0)

/** True when `token` is one of the cited values, allowing the rounding it shows and a x100 or /100 reading of a fraction. */
function matchesCited(token: string, cited: number[]): boolean {
  const t = Number(token.replace(/,/g, ''))
  if (!Number.isFinite(t)) return false
  const tol = 0.5 * 10 ** -decimals(token) + 1e-9
  return cited.some((v) => [v, Math.abs(v), v * 100, Math.abs(v) * 100, v / 100].some((c) => Math.abs(t - c) <= tol))
}

export interface NarrativeCheck {
  ok: boolean
  offending: string[]
  /** The text with offending sentences removed. */
  cleaned: string
}

export function checkNarrative(text: string, index: CitableIndex): NarrativeCheck {
  const offending: string[] = []
  const kept: string[] = []
  for (const sentence of splitSentences(text)) {
    if (!sentence.trim()) { kept.push(sentence); continue }
    const refs = [...sentence.matchAll(CITATION)].map((m) => ({ id: m[1], key: m[2] }))
    const bare = stripDates(sentence.replace(CITATION, ' '))
    const numbers = bare.match(/\d[\d,]*(?:\.\d+)?/g) ?? []
    // A marker that looks like a citation but does not parse, or names nothing recorded, is a defect even in a sentence without numbers.
    const malformed = /\[\[[^\]]*\]\]/.test(sentence.replace(CITATION, ''))
    const unresolved = refs.some((r) => !(r.key in (index.get(r.id) ?? {})))
    let bad = malformed || unresolved
    if (!bad && numbers.length > 0) {
      const cited = refs.map((r) => index.get(r.id)![r.key]).filter((v): v is number => typeof v === 'number')
      bad = refs.length === 0 || !numbers.every((n) => matchesCited(n, cited))
    }
    if (bad) offending.push(sentence.trim())
    else kept.push(sentence)
  }
  return { ok: offending.length === 0, offending, cleaned: kept.join('').replace(/[ \t]+\n/g, '\n').trim() }
}

export function citableIndex(records: NarrativeRecord[]): CitableIndex {
  const index: CitableIndex = new Map()
  for (const r of records) index.set(r.result_id, { ...(index.get(r.result_id) ?? {}), ...r.citable })
  return index
}

/** The narrative from recorded results alone: fixed sentences, each figure with its citation. */
export function templateNarrative(verdictText: string, records: NarrativeRecord[], limits: string[]): string {
  const lines = [`**${verdictText}**`]
  for (const r of records) {
    if (r.measured && r.reading) lines.push(r.reading)
    else if (!r.measured) lines.push(`${r.item} could not be measured: ${r.reason ?? 'no usable result'}.`)
  }
  if (limits.length) lines.push(`Limits: ${limits.join(' ')}`)
  return lines.join('\n\n')
}
