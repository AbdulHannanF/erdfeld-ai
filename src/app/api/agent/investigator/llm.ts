/**
 * The investigator's model calls, behind one interface so the run can be tested without a model.
 *
 * What the model does here, and nothing else:
 *   - `propose`        which catalogue hypotheses apply, and a prior for each (structured JSON);
 *   - `explainStep`    one display-only sentence for why the next evidence is the next evidence;
 *   - `classifyImagery` pick one category from the catalogue's list for a picture;
 *   - `writeNarrative` the dossier text, from recorded results only;
 *   - `searchReports`  a separate web-grounded call for reports of the event (context, not evidence).
 *
 * It never computes a number that reaches a posterior: priors are bounded and normalised by
 * `belief.ts`, and the picture's category becomes a likelihood ratio only through the catalogue.
 */

import { ApiError, GoogleGenAI, type GenerateContentConfig } from '@google/genai'
import { z } from 'zod'

import { toLlmSchema } from '../engine/llm-schema'
import { thinkingLevelFor, type Phase } from '../lib/gemini'
import { getLogger } from '../lib/logger'
import { geminiModelChain, isGemma } from '../lib/models'
import { scrubSecret } from '../lib/providers'
import { CATALOGUE, FAMILY_IDS, type EvidenceItem, type Family, type FamilyId } from './catalogue'

const log = getLogger('investigator/llm')

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ProposeInput {
  question?: string
  familyHint?: FamilyId
  bbox: [number, number, number, number]
  areaKm2: number
  today: string
  window?: { start: string; end: string }
}

export interface Proposal {
  hasSpecificEvent: boolean
  family: FamilyId | null
  windowStart: string
  windowEnd: string
  /** A place name the model recognises for the coordinates, or empty. Context for the web search only. */
  place: string
  hypotheses: Array<{ id: string; prior: number; why: string }>
}

export interface StepRationaleInput {
  family: Family
  item: EvidenceItem
  leading: Array<{ label: string; p: number }>
  voiBits: number
  alternatives: Array<{ title: string; voiBits: number }>
  skipped: Array<{ title: string; reason: string }>
}

export interface ImageryInput {
  item: EvidenceItem
  /** PNG, base64 without a data-URL prefix; absent when the operation returned no picture. */
  imageBase64?: string
  /** The vision tool's own description of the picture. */
  description: string
}

export interface NarrativeRecord {
  result_id: string
  item: string
  op: string
  status: string
  measured: boolean
  /** What the measurement shows, in the catalogue's words. */
  reading?: string
  reason?: string
  /** The only figures the narrative may quote: field to value. */
  citable: Record<string, number | string>
  caveat?: string
}

export interface NarrativeInput {
  verdictText: string
  question?: string
  place: string
  window: { start: string; end: string }
  records: NarrativeRecord[]
  limits: string[]
  /** Sentences of a previous attempt that broke the citation rule, to correct. */
  feedback?: string[]
}

export interface ReportSearchInput {
  subject: string
  place: string
  bbox: [number, number, number, number]
  window: { start: string; end: string }
}

export interface RawReport { title: string; publisher: string; published: string; url: string }

export interface ReportSearchResult {
  reports: RawReport[]
  /** The web pages the search actually returned (grounding chunks). */
  chunks: Array<{ uri: string; title: string; domain: string }>
  queries: string[]
}

export interface InvestigatorLlm {
  propose(input: ProposeInput): Promise<Proposal>
  explainStep(input: StepRationaleInput): Promise<string>
  classifyImagery(input: ImageryInput): Promise<string>
  writeNarrative(input: NarrativeInput): Promise<string>
  searchReports(input: ReportSearchInput): Promise<ReportSearchResult>
  /** Tokens used by this run's model calls so far, when the implementation counts them. */
  usage?(): UsageTally
}

export interface UsageTally { calls: number; promptTokens: number; outputTokens: number; thoughtTokens: number; cachedTokens: number }

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface GenClient {
  models: { generateContent(params: { model: string; contents: any; config?: GenerateContentConfig }): Promise<any> }
}

export interface GeminiLlmOptions {
  apiKey?: string
  model?: string
  signal?: AbortSignal
  client?: GenClient
  sleep?: (ms: number) => Promise<void>
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const statusOf = (err: unknown): number | undefined => (err instanceof ApiError ? err.status : (err as any)?.status ?? (err as any)?.code)

/** Remove what Gemini's response schema rejects, at every depth. */
function strip(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strip)
  if (schema && typeof schema === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(schema)) if (k !== 'additionalProperties' && k !== '$schema') out[k] = strip(v)
    return out
  }
  return schema
}

const jsonSchemaOf = (s: z.ZodObject<any>) => strip(toLlmSchema(s))

export class GeminiInvestigatorLlm implements InvestigatorLlm {
  private client: GenClient
  private chain: string[]
  private signal?: AbortSignal
  private apiKey?: string
  private sleep: (ms: number) => Promise<void>
  private tally: UsageTally = { calls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0 }

  /** Tokens the provider billed across every call this object made. */
  usage(): UsageTally {
    return { ...this.tally }
  }

  constructor(opts: GeminiLlmOptions) {
    this.client = opts.client ?? (new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as GenClient)
    this.chain = geminiModelChain(opts.model)
    this.signal = opts.signal
    this.apiKey = opts.apiKey
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** One generation with bounded retries per model and the fallback chain; the text and any grounding.
   *  Thinking effort follows the agent's per-phase setting (`GEOAGENT_GEMINI_THINKING_PLAN` / `_SYNTHESIS` /
   *  `GEOAGENT_GEMINI_THINKING`): choosing a family and priors is the planning phase, reading and writing up
   *  results is synthesis. */
  private async generate(contents: any, config: GenerateContentConfig, phase: Phase = 'synthesis', bestEffort = false): Promise<{ text: string; grounding: any }> {
    let last: unknown
    // A best-effort call (context the verdict does not depend on) is made once, on the first model: no retry, no fallback.
    for (const model of bestEffort ? this.chain.slice(0, 1) : this.chain) {
      const cfg: GenerateContentConfig = { ...config, abortSignal: this.signal, httpOptions: { retryOptions: { attempts: 1 } } }
      if (/^gemini-3/i.test(model) && !isGemma(model) && !cfg.thinkingConfig) cfg.thinkingConfig = { thinkingLevel: thinkingLevelFor(phase, process.env) }
      for (let attempt = 0; attempt < (bestEffort ? 1 : 2); attempt++) {
        try {
          const res = await this.client.models.generateContent({ model, contents, config: cfg })
          const um = res.usageMetadata
          if (um) {
            this.tally.calls++
            this.tally.promptTokens += um.promptTokenCount ?? 0
            this.tally.outputTokens += um.candidatesTokenCount ?? 0
            this.tally.thoughtTokens += um.thoughtsTokenCount ?? 0
            this.tally.cachedTokens += um.cachedContentTokenCount ?? 0
          }
          const blocked = res.promptFeedback?.blockReason
          if (blocked) throw new Error(`the request was blocked: ${blocked}`)
          return { text: String(res.text ?? ''), grounding: res.candidates?.[0]?.groundingMetadata }
        } catch (err) {
          last = err
          if (this.signal?.aborted) throw err
          const status = statusOf(err)
          if (status !== undefined && !RETRYABLE.has(status) && status !== 404) throw this.scrub(err)
          if (status === 404) break
          if (attempt === 0) await this.sleep(1500)
        }
      }
      log.warn({ model, status: statusOf(last) }, 'model unavailable; trying the next in the chain')
    }
    throw this.scrub(last)
  }

  private scrub(err: unknown): Error {
    const msg = scrubSecret(String((err as any)?.message ?? err), this.apiKey).replace(/\s+/g, ' ').slice(0, 300)
    return Object.assign(new Error(msg), { status: statusOf(err) })
  }

  private async json<S extends z.ZodObject<any>>(schema: S, system: string, prompt: string, extra: Array<{ inlineData: { mimeType: string; data: string } }> = [], phase: Phase = 'synthesis'): Promise<z.output<S>> {
    const { text } = await this.generate(
      [{ role: 'user', parts: [{ text: prompt }, ...extra] }],
      { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: jsonSchemaOf(schema), maxOutputTokens: 4096, temperature: 0.2 },
      phase,
    )
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new Error('the model did not return JSON') }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`the model's JSON did not match the schema: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    return parsed.data
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    const catalogue = CATALOGUE.map((f) => `Family ${f.id}: ${f.about}\n${f.hypotheses.map((h) => `  - ${h.id}: ${h.label}. ${h.description}`).join('\n')}`).join('\n\n')
    const out = await this.json(
      ProposalSchema,
      'You triage an Earth-observation question for a deterministic investigator. You choose from a fixed catalogue of hypotheses and give each a prior plausibility from the question alone. You do not measure anything and you never invent ids. Reply with JSON only.',
      [
        `Today: ${input.today}.`,
        `Area: bounding box [west, south, east, north] = [${input.bbox.map((n) => n.toFixed(4)).join(', ')}], about ${input.areaKm2.toFixed(1)} km2.`,
        input.window ? `Time window given: ${input.window.start} to ${input.window.end}.` : 'No time window was given; extract one from the question if it names dates, otherwise leave window_start and window_end empty.',
        input.familyHint ? `The user says this is about: ${input.familyHint}. Use that family.` : '',
        `Question: ${input.question?.trim() || '(none: the user only drew an area)'}`,
        '',
        'has_specific_event is true when the question names or implies an event, hazard or kind of change to explain, including "what happened to <named feature> during <dates>" (a river in the monsoon season implies flooding to test); false only when nothing at all is named ("what is going on here?") or the question is absent.',
        'Choose the one family whose hypotheses compete to explain the question. Decide by what the question asks about and the place and season, not by the land cover in the picture: a river, flooding, rain or inundation is water; burning or smoke is fire; construction or buildings is structures; crops or forest cover is vegetation_loss. List 2 to 5 of that family\'s hypothesis ids with a prior each (0 to 1, relative plausibility from the question alone; the system bounds and normalises them). Priors reflect only the question, not guesses about the place.',
        'place: a short place name only if you are confident of it from the coordinates or question, else an empty string.',
        '',
        catalogue,
      ].filter(Boolean).join('\n'),
      [],
      'plan',
    )
    return {
      hasSpecificEvent: out.has_specific_event,
      family: (FAMILY_IDS as readonly string[]).includes(out.family) ? (out.family as FamilyId) : null,
      windowStart: out.window_start, windowEnd: out.window_end, place: out.place,
      hypotheses: out.hypotheses.map((h) => ({ id: h.id, prior: h.prior, why: h.why })),
    }
  }

  async explainStep(i: StepRationaleInput): Promise<string> {
    const { text } = await this.generate(
      [{ role: 'user', parts: [{ text: [
        'Write ONE sentence (at most 30 words) saying why this evidence is the next one to gather. Use only the facts below. Do not state any number you were not given and do not predict the result.',
        `Leading hypotheses: ${i.leading.map((l) => `${l.label} (${(l.p * 100).toFixed(0)}%)`).join('; ')}.`,
        `Next evidence: ${i.item.title}; it would settle ${i.item.decides}; expected to remove ${i.voiBits.toFixed(2)} bits of uncertainty.`,
        i.alternatives.length ? `Other candidates: ${i.alternatives.map((a) => `${a.title} (${a.voiBits.toFixed(2)} bits)`).join('; ')}.` : '',
        i.skipped.length ? `Not usable here: ${i.skipped.map((s) => `${s.title}: ${s.reason}`).join('; ')}.` : '',
      ].filter(Boolean).join('\n') }] }],
      { maxOutputTokens: 200, temperature: 0.3 },
    )
    return text.replace(/\s+/g, ' ').trim()
  }

  async classifyImagery(i: ImageryInput): Promise<string> {
    if (i.item.scale.kind !== 'categories') throw new Error('not a categorical item')
    const cats = i.item.scale.categories
    const schema = z.object({ category: z.enum(cats.map((c) => c.value) as [string, ...string[]]), basis: z.string() })
    const out = await this.json(
      schema,
      'You classify one satellite true-colour picture into exactly one category from a fixed list. Choose only from what is visible. If the ground is not readable, choose the cloud/shadow/haze category. Reply with JSON only.',
      [
        `Question: ${String(i.item.args.question ?? i.item.title)}`,
        `Categories:\n${cats.map((c) => `- ${c.value}: ${c.why}`).join('\n')}`,
        `A vision tool described the picture as: ${i.description.slice(0, 1200)}`,
        i.imageBase64 ? 'The picture is attached.' : 'No picture is attached; classify from the description alone.',
        'basis: one short sentence naming what you saw.',
      ].join('\n'),
      i.imageBase64 ? [{ inlineData: { mimeType: 'image/png', data: i.imageBase64 } }] : [],
    )
    return out.category
  }

  async writeNarrative(i: NarrativeInput): Promise<string> {
    const { text } = await this.generate(
      [{ role: 'user', parts: [{ text: [
        'Write the summary of an investigation for a decision maker, in plain markdown, at most 170 words, using ONLY the recorded results below.',
        'Rules, all strict:',
        '- Every sentence that contains a digit must end with one or more citations [[result_id#field]], using only a result_id and field listed below, and every number you write must be that field\'s value (rounded as you like).',
        '- Write counts and ordinals as words (two measurements, the first pass); digits only for cited figures and dates.',
        '- Do not state probabilities, percentages of belief or any number that is not a listed field value.',
        '- State the verdict exactly as given. Say what each measurement showed, what could not be measured and why, and the limits. Do not mention anything not in the records, and do not explain causes the records do not show.',
        '',
        `Verdict: ${i.verdictText}`,
        `Question: ${i.question?.trim() || '(an area was drawn without a question)'}`,
        `Place: ${i.place || 'not named'}. Window: ${i.window.start} to ${i.window.end}.`,
        `Recorded results (JSON): ${JSON.stringify(i.records)}`,
        `Limits: ${i.limits.join(' | ')}`,
        i.feedback?.length ? `A previous draft broke the citation rule in these sentences; do not repeat them:\n${i.feedback.map((s) => `- ${s}`).join('\n')}` : '',
      ].filter(Boolean).join('\n') }] }],
      { maxOutputTokens: 900, temperature: 0.2 },
    )
    return text.trim()
  }

  async searchReports(i: ReportSearchInput): Promise<ReportSearchResult> {
    const query = reportSearchQuery(i)
    const brief = [
      `Use Google Search now, with the query: ${query}`,
      `You must search before answering; do not answer from memory. Find published reports (news, agency bulletins, scientific or government pages) of: ${i.subject}.`,
      `Place: ${i.place || 'not named'}; coordinates [west, south, east, north] = [${i.bbox.map((n) => n.toFixed(3)).join(', ')}].`,
      `Time: between ${i.window.start} and ${i.window.end} (reports published later about this period are welcome).`,
      'List up to 6 reports you actually found, each with title, publisher, published (YYYY-MM-DD, or empty if the page gives no date) and url. Do not list a report you did not find. If you found none, list none.',
    ]
    // Plain lines, not JSON: with the search tool the JSON response type returned nothing in live runs.
    const result = await this.generate(
      [{ role: 'user', parts: [{ text: [...brief, 'Return one line per report, exactly: REPORT | title | publisher | published | url (use the url exactly as the search result gives it).'].join('\n') }] }],
      { tools: [{ googleSearch: {} }], maxOutputTokens: 1500, temperature: 0.1 },
      'synthesis',
      true,
    )
    const reports = parseReportLines(result.text)
    const chunks = ((result.grounding?.groundingChunks ?? []) as any[])
      .map((c) => c.web)
      .filter((w) => w?.uri)
      .map((w) => ({ uri: String(w.uri), title: String(w.title ?? ''), domain: String(w.domain ?? w.title ?? '') }))
    return { reports, chunks, queries: (result.grounding?.webSearchQueries ?? []) as string[] }
  }
}

/** The web-search query for an event: its short name, the place (or the coordinates) and the month(s) of the window,
 *  e.g. "Wildfire or burn scar Lahaina August 2023". */
export function reportSearchQuery(i: ReportSearchInput): string {
  const month = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  }
  const a = month(i.window.start)
  const b = month(i.window.end)
  const where = i.place || `${((i.bbox[1] + i.bbox[3]) / 2).toFixed(2)}, ${((i.bbox[0] + i.bbox[2]) / 2).toFixed(2)}`
  return `${i.subject} ${where} ${a === b ? a : `${a} to ${b}`}`
}

export function parseReportLines(text: string): RawReport[] {
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(?:[-*]\s*)?REPORT\s*\|(.*)$/i.exec(line)
    if (!m) return []
    const [title = '', publisher = '', published = '', url = ''] = m[1].split('|').map((x) => x.trim())
    return title && url ? [{ title, publisher, published, url }] : []
  })
}

const ProposalSchema = z.object({
  has_specific_event: z.boolean(),
  family: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  place: z.string(),
  hypotheses: z.array(z.object({ id: z.string(), prior: z.number(), why: z.string() })),
})

