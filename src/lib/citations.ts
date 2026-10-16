/**
 * P4.2 — Grounded citations.
 *
 * The agent tags every numeric claim in its analysis with an inline marker
 * `[[<result_id>#<key>]]` (e.g. `[[fetch_ndvi-0#mean]]`). This module is the
 * pure parse + resolve layer: it has no React and no store dependency so it can
 * be unit-tested in isolation. The UI (ChatPanel / CitationPill) consumes these
 * helpers to render numbered pills and resolve them against the in-session tool
 * results.
 */

/** Array figure shape (mirrors `SummaryArray` on the tool side). */
export type CitationArray = Array<{ label: string; value: number }>
export type CitationValue = number | string | CitationArray

/** A tool result the chat can cite, keyed by `result_id` in the store. */
export interface CitableToolResult {
  tool: string
  resultId: string
  summaryData: Record<string, CitationValue>
  provenance?: { source: string; date?: string; method: string; clip: string }
  confidence?: 'high' | 'medium' | 'low'
}

/** A raw `[[id#key]]` marker located in rendered text. */
export interface CitationRef {
  /** The full matched marker, e.g. `[[fetch_ndvi-0#mean]]`. */
  raw: string
  resultId: string
  key: string
  /** Character offset of the marker start within the source text. */
  index: number
}

/** A citation resolved against the available tool results. */
export interface ResolvedCitation {
  resultId: string
  key: string
  tool: string | null
  value: CitationValue | null
  /** True when the result_id + key both exist in the tool-result map. */
  resolved: boolean
  provenance?: CitableToolResult['provenance']
  confidence?: CitableToolResult['confidence']
}

/** A segment of text split around its citation markers. */
export type TextSegment =
  | { type: 'text'; value: string }
  | { type: 'citation'; ref: CitationRef }

/** A result id: the content hash `r_` + 16 hex, or the older `<tool>-<n>` ordinal that saved
 *  transcripts and manifests may still carry. */
const RESULT_ID = 'r_[0-9a-f]{16}|[A-Za-z0-9_]+-\\d+'

/**
 * Matches `[[<result_id>#<key>]]` where:
 *  - result_id is `r_<16 hex>` (or the older `<tool_name>-<ordinal>`)
 *  - key is letters/digits/underscore
 * The trailing `g` flag is required for iterative use; callers must not share a
 * single compiled instance across reentrant calls (we build a fresh one each time).
 *
 * This only matches a bracket pair whose ENTIRE contents are exactly `id#key` —
 * `parseCitations` (below) stays strict on purpose, so its callers keep getting
 * only well-formed refs. It does NOT match every marker the LLM actually emits;
 * see MARKER_PATTERN / BARE_REF_PATTERN for the broader shapes
 * `splitTextWithCitations` has to handle so raw markup never reaches the user.
 */
export const CITATION_PATTERN = `\\[\\[(${RESULT_ID})#([A-Za-z0-9_]+)\\]\\]`

function newRegex(): RegExp {
  return new RegExp(CITATION_PATTERN, 'g')
}

/**
 * Broad `[[...]]` marker shape — any content, bounded length, no nested
 * brackets. 2026-08-17 QA sweep (finding #7) caught the LLM
 * emitting shapes CITATION_PATTERN never matches, e.g.
 *   `[[fetch_dem-1#min_elevation_m=2334, fetch_dem-1#max_elevation_m=4093]]`
 *   `[[detect_change]]`
 * and because nothing stripped the non-matching ones, they rendered as literal
 * brackets. This pattern finds every `[[...]]` span so each one can be resolved
 * into zero or more real citations (never left as raw text — see
 * splitTextWithCitations). The length cap guards against a runaway match if a
 * stray `[[` is never closed (e.g. a truncated streaming token).
 */
const MARKER_PATTERN = '\\[\\[([^\\[\\]]{1,500})\\]\\]'

function newMarkerRegex(): RegExp {
  return new RegExp(MARKER_PATTERN, 'g')
}

/**
 * The well-formed reference shape (`<id>-<n>#<key>`) WITHOUT the `[[ ]]`
 * delimiters — same id/key character classes as CITATION_PATTERN. Run globally
 * over a marker's inner content, it finds every ref inside regardless of how
 * many there are or what separates them: the `=2334` suffix and `, ` separator
 * in the multi-key example above are simply not part of the match, so they're
 * skipped over rather than needing to be parsed out explicitly.
 */
const BARE_REF_PATTERN = `(${RESULT_ID})#([A-Za-z0-9_]+)`

function newBareRefRegex(): RegExp {
  return new RegExp(BARE_REF_PATTERN, 'g')
}

/** Every well-formed ref found inside one marker's inner text (may be zero, one,
 *  or several — see MARKER_PATTERN's doc comment for why). */
function extractBareRefs(inner: string): Array<{ resultId: string; key: string }> {
  const re = newBareRefRegex()
  const out: Array<{ resultId: string; key: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    out.push({ resultId: m[1], key: m[2] })
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/** Extract every citation marker from `text`, in order of appearance. */
export function parseCitations(text: string): CitationRef[] {
  if (!text) return []
  const re = newRegex()
  const out: CitationRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], resultId: m[1], key: m[2], index: m.index })
    // Guard against zero-length matches (not possible with this pattern, but safe).
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/** True if `text` contains at least one citation marker. */
export function hasCitations(text: string): boolean {
  return newRegex().test(text)
}

/**
 * Split `text` into an ordered list of plain-text and citation segments. Text
 * between/around markers is preserved verbatim so the caller can re-apply other
 * inline rendering (e.g. search highlighting) to the text segments.
 *
 * Unlike `parseCitations`, this scans the BROAD `[[...]]` marker shape so it
 * catches every marker the LLM emits, not just the well-formed single-ref one.
 * Each marker is resolved independently:
 *  - one or more well-formed `<id>-<n>#<key>` refs inside → one citation segment
 *    per ref (so a marker packing multiple keys into one bracket pair, e.g.
 *    `[[fetch_dem-1#min_elevation_m=2334, fetch_dem-1#max_elevation_m=4093]]`,
 *    renders as TWO pills instead of one unparseable blob);
 *  - none (e.g. a bare tool name like `[[detect_change]]`) → the marker is
 *    dropped silently. Never fail open into the user's text: anything
 *    bracket-shaped that isn't a resolvable citation must not be displayed.
 */
export function splitTextWithCitations(text: string): TextSegment[] {
  if (!text) return []
  const markerRe = newMarkerRegex()
  const segments: TextSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(text)) !== null) {
    const refs = extractBareRefs(m[1])

    // Flush the plain text preceding this marker regardless of whether the
    // marker itself resolves to anything — only the marker's own span is ever
    // at risk of leaking, not the text around it.
    if (m.index > last) {
      segments.push({ type: 'text', value: text.slice(last, m.index) })
    }
    for (const ref of refs) {
      segments.push({
        type: 'citation',
        ref: { raw: `[[${ref.resultId}#${ref.key}]]`, resultId: ref.resultId, key: ref.key, index: m.index },
      })
    }
    // refs.length === 0: the marker is swallowed here — no text, no citation.

    last = m.index + m[0].length
    if (m.index === markerRe.lastIndex) markerRe.lastIndex++
  }
  if (last < text.length) {
    segments.push({ type: 'text', value: text.slice(last) })
  }
  return segments
}

/**
 * Strip every `[[...]]` marker from `text`, well-formed or not — the same
 * "never fail open" rule `splitTextWithCitations` applies, for plain-text
 * consumers that have no pill to render into (copy-to-clipboard, PDF export,
 * notifications). A leaked `[[fetch_dem-1#min_elevation_m=2334, ...]]` in a
 * copied answer or a generated report is exactly the failure this module
 * exists to prevent.
 */
export function stripCitationMarkup(text: string): string {
  if (!text) return ''
  return text.replace(newMarkerRegex(), '').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Resolve a single citation against the tool-result map. An unresolved citation
 * (bad result_id or missing key — typically an LLM hallucination) returns
 * `resolved: false` so the UI can render it visibly as an error rather than
 * silently swallowing it.
 */
export function resolveCitation(
  ref: { resultId: string; key: string },
  toolResults: Record<string, CitableToolResult>,
): ResolvedCitation {
  const tr = toolResults[ref.resultId]
  if (!tr) {
    return { resultId: ref.resultId, key: ref.key, tool: null, value: null, resolved: false }
  }
  const has = Object.prototype.hasOwnProperty.call(tr.summaryData ?? {}, ref.key)
  return {
    resultId: ref.resultId,
    key: ref.key,
    tool: tr.tool,
    value: has ? tr.summaryData[ref.key] : null,
    resolved: has,
    provenance: tr.provenance,
    confidence: tr.confidence,
  }
}

/** Type guard: is a resolved citation value an auto-chartable numeric series? */
export function isChartableArray(value: CitationValue | null | undefined): value is CitationArray {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (p) =>
        p != null &&
        typeof p === 'object' &&
        typeof (p as any).label === 'string' &&
        typeof (p as any).value === 'number' &&
        Number.isFinite((p as any).value),
    )
  )
}

/** Format a resolved scalar value for display in a pill / popover. */
export function formatCitationValue(value: CitationValue | null): string {
  if (value == null) return '—'
  if (Array.isArray(value)) {
    return value.map((p) => `${p.label}: ${p.value}`).join(', ')
  }
  if (typeof value === 'number') {
    // Trim noisy float tails without forcing decimals on integers.
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
  }
  return String(value)
}

/**
 * Build the citation hint the orchestrator appends to a tool result before
 * feeding it back to the model, e.g.
 *   `[citation_id: fetch_ndvi-0 · fields: mean=0.42, vegetation_pct=64]`
 * This tells the model the exact `result_id` and field keys it may cite. Returns
 * an empty string when there is nothing citable.
 */
export function buildCitationHint(
  resultId: string,
  summaryData?: Record<string, CitationValue>,
): string {
  if (!summaryData) return ''
  const keys = Object.keys(summaryData)
  if (keys.length === 0) return ''
  const fields = keys
    .map((k) => {
      const v = summaryData[k]
      if (Array.isArray(v)) return `${k}=[${v.map((p) => `${p.label}:${p.value}`).join(', ')}]`
      return `${k}=${v}`
    })
    .join(', ')
  return `\n[citation_id: ${resultId} · citable fields: ${fields}]`
}
