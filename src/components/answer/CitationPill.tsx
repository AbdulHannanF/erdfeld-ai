'use client'

/**
 * The inline `[[result_id#field]]` markers the agent writes, as numbered buttons.
 *
 * A resolved citation is a button: pressing it opens that result's row in the Evidence tab and
 * marks the layer it came from on the map, so "where does this number come from?" is one click.
 * A citation that does not resolve (a result id or field that does not exist this session, which
 * means the model made it up) is drawn red and explains itself instead of vanishing.
 *
 * MiniCitationChart draws an array-valued figure (land-cover shares, monthly rainfall) as a small
 * Vega-Lite chart under the text.
 */

import { useMemo } from 'react'
import { AlertCircle } from 'lucide-react'
import { resolveCitation, formatCitationValue, type CitableToolResult, type CitationArray } from '@/lib/citations'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import VegaChart from '@/components/answer/VegaChart'
import { seriesSpec } from '@/lib/chart-spec'
import { humanizeKey, unitOf } from '@/components/answer/derive'
import { useUi } from '@/store/useUi'

const PILL =
  'not-prose mx-0.5 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-sm px-1 align-baseline text-caption-strong leading-none tabular-nums transition-colors'

/** A single inline citation marker. `index` is the 1-based display number. */
export function CitationPill({
  resultId,
  citeKey,
  index,
  toolResults,
  showValue = false,
  textAfter = '',
}: {
  resultId: string
  citeKey: string
  index: number
  toolResults: Record<string, CitableToolResult>
  /** The marker stands where the figure should be: print the recorded value, not its number. */
  showValue?: boolean
  /** The prose right after the marker, so a unit the sentence already carries is not repeated. */
  textAfter?: string
}) {
  const focusEvidence = useUi((s) => s.focusEvidence)
  const resolved = useMemo(() => resolveCitation({ resultId, key: citeKey }, toolResults), [resultId, citeKey, toolResults])

  if (!resolved.resolved) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={`${PILL} border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20`} aria-label="Unresolved citation">
            !
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3 text-caption">
          <div className="flex items-center gap-1.5 font-semibold text-danger">
            <AlertCircle className="size-3.5" aria-hidden />
            Unresolved citation
          </div>
          <p className="mt-1.5 leading-relaxed text-muted-foreground">
            The answer referred to <code className="rounded-sm bg-muted px-1">{resultId}#{citeKey}</code>, but no result with that id and field exists in this session.
          </p>
        </PopoverContent>
      </Popover>
    )
  }

  const value = formatCitationValue(resolved.value)
  const scalar = typeof resolved.value === 'number' || typeof resolved.value === 'string'
  const unit = typeof resolved.value === 'number' ? unitOf(citeKey).trim() : ''
  const printed = scalar && showValue ? (unit && !textAfter.trimStart().toLowerCase().startsWith(unit.toLowerCase()) ? `${value} ${unit}` : value) : null
  if (printed !== null) {
    return (
      <button
        type="button"
        onClick={() => focusEvidence(resultId, citeKey)}
        className="not-prose mx-0.5 inline cursor-pointer rounded-sm bg-accent px-1 align-baseline font-semibold tabular-nums text-accent-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
        aria-label={`${humanizeKey(citeKey)} ${printed}. Show its evidence and the layer on the map`}
        title={`${humanizeKey(citeKey)} (citation ${index})`}
        data-citation={`${resultId}#${citeKey}`}
      >
        {printed}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => focusEvidence(resultId, citeKey)}
      className={`${PILL} bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground`}
      aria-label={`Citation ${index}: ${humanizeKey(citeKey)} ${value}. Show its evidence and the layer on the map`}
      title={`${humanizeKey(citeKey)}: ${value}`}
      data-citation={`${resultId}#${citeKey}`}
    >
      {index}
    </button>
  )
}

/** Compact inline chart for an array-valued cited figure (bars, or a line for dated series). */
export function MiniCitationChart({ title, data }: { title: string; data: CitationArray }) {
  // Cap the number of marks so a long monthly series stays legible.
  const spec = useMemo(() => seriesSpec(data.slice(0, 24)), [data])
  return (
    <div className="not-prose mt-3 rounded-lg border border-border bg-muted/50 p-2.5">
      <div className="mb-1.5 text-muted-foreground text-label">{title}</div>
      <VegaChart spec={spec} height={140} />
    </div>
  )
}

export default CitationPill
