'use client'

import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { CitationPill, MiniCitationChart } from '@/components/answer/CitationPill'
import ChartCard from '@/components/answer/ChartCard'
import { useStore } from '@/store/useStore'
import type { ChartItem } from '@/lib/chart-spec'
import {
  resolveCitation,
  splitTextWithCitations,
  isChartableArray,
  type CitableToolResult,
  type CitationRef,
} from '@/lib/citations'

/** Every well-formed citation ref found in `content`, in first-appearance order. Goes through
 *  `splitTextWithCitations` (not `parseCitations`) so a marker packing several keys into one
 *  `[[...]]` pair still yields every ref inside it. */
export function citationRefsIn(content: string): CitationRef[] {
  const out: CitationRef[] = []
  for (const seg of splitTextWithCitations(content)) {
    if (seg.type === 'citation') out.push(seg.ref)
  }
  return out
}

/** First-appearance ordering of unique `result_id#key` markers to a display number. */
function buildCitationNumberMap(content: string): Map<string, number> {
  const map = new Map<string, number>()
  let n = 0
  for (const ref of citationRefsIn(content)) {
    const k = `${ref.resultId}#${ref.key}`
    if (!map.has(k)) map.set(k, ++n)
  }
  return map
}

/** The text before a marker ends in a number (with its unit): the marker is a footnote to it. */
const NUMBER_BEFORE = /\d[\d.,]*\s*(?:%|[A-Za-z\u00b5\u00b0\u00b2\u00b3/]{1,6})?\s*$/

/** True when the prose before a marker holds no number for it to footnote, so the marker stands in
 *  for the figure and prints the recorded value. */
export function markerStandsInForFigure(textBefore: string): boolean {
  return !NUMBER_BEFORE.test(textBefore)
}

/** Replace `[[id#key]]` markers in string children with numbered pills, keeping the text around them. */
function renderInlineWithCitations(
  children: React.ReactNode,
  numberMap: Map<string, number>,
  toolResults: Record<string, CitableToolResult>,
): React.ReactNode {
  const renderChild = (child: React.ReactNode, ki: number): React.ReactNode => {
    if (typeof child !== 'string') return child
    const segments = splitTextWithCitations(child)
    if (segments.length === 1 && segments[0].type === 'text') return child
    return segments.map((seg, si) => {
      const key = `${ki}-${si}`
      if (seg.type === 'text') return <span key={key}>{seg.value}</span>
      const num = numberMap.get(`${seg.ref.resultId}#${seg.ref.key}`) ?? 0
      // A marker with no number before it stands in for the figure: it prints the recorded value
      // (otherwise "holds [1] fields over [2] ha" reads as the numbers 1 and 2).
      const prev = segments[si - 1]
      const next = segments[si + 1]
      const standsIn = markerStandsInForFigure(prev?.type === 'text' ? prev.value : '')
      return (
        <CitationPill
          key={key}
          resultId={seg.ref.resultId}
          citeKey={seg.ref.key}
          index={num}
          toolResults={toolResults}
          showValue={standsIn}
          textAfter={next?.type === 'text' ? next.value : ''}
        />
      )
    })
  }
  return Array.isArray(children) ? children.map((c, i) => renderChild(c, i)) : renderChild(children, 0)
}

/**
 * The analysis text with its citation pills, and charts for any array-valued cited figure under
 * it. Shared by the finished answer and the streaming one, so pills appear as the text arrives
 * (the tool results are already in the store by then).
 */
const UNVERIFIED = '**Unverified statements.**'
const BUDGET = /step\(s\) were skipped or stopped/

/** Split the closing honest-state blocks off the answer: the "Unverified statements" list the
 *  checker appends, and the note that the time budget skipped or stopped steps. They are shown as
 *  callouts, not as prose, so they cannot be read as part of the answer. */
export function splitCallouts(content: string): { body: string; unverified?: string; budget?: string } {
  let body = content
  let unverified: string | undefined
  const at = body.indexOf(UNVERIFIED)
  if (at >= 0) {
    unverified = body.slice(at + UNVERIFIED.length).trim()
    body = body.slice(0, at)
  }
  const parts = body.split(/\n{2,}/)
  const bi = parts.findIndex((p) => BUDGET.test(p))
  let budget: string | undefined
  if (bi >= 0) {
    budget = parts[bi].trim()
    parts.splice(bi, 1)
  } else if (unverified) {
    const up = unverified.split(/\n{2,}/)
    const ui = up.findIndex((p) => BUDGET.test(p))
    if (ui >= 0) {
      budget = up[ui].trim()
      up.splice(ui, 1)
      unverified = up.join('\n\n').trim()
    }
  }
  return { body: parts.join('\n\n').trim(), unverified: unverified || undefined, budget }
}

const CitedMarkdown = memo(function CitedMarkdown({
  content: rawContent,
  toolResults,
  charts: messageCharts,
  liveCharts,
}: {
  content: string
  /** Vega-Lite charts made for this answer (a finished message carries its own snapshot). */
  charts?: ChartItem[]
  /** The streaming answer: show the live store's charts instead. */
  liveCharts?: boolean
  /** When omitted (the live answer) resolves against the live store; a finished message passes its
   *  own snapshot so its citations stay correct after later questions. */
  toolResults?: Record<string, CitableToolResult>
}) {
  const liveToolResults = useStore((s) => s.toolResults)
  const storeCharts = useStore((s) => s.charts)
  const agentCharts = liveCharts ? storeCharts : messageCharts
  const effective = toolResults ?? liveToolResults
  const split = useMemo(() => splitCallouts(rawContent), [rawContent])
  const content = split.body
  const numberMap = useMemo(() => buildCitationNumberMap(content), [content])

  // Cited array figures are charted under the text.
  const charts = useMemo(() => {
    const seen = new Set<string>()
    const out: { title: string; data: { label: string; value: number }[] }[] = []
    for (const ref of citationRefsIn(content)) {
      const k = `${ref.resultId}#${ref.key}`
      if (seen.has(k)) continue
      seen.add(k)
      const res = resolveCitation(ref, effective)
      if (res.resolved && isChartableArray(res.value)) {
        out.push({ title: `${ref.key.replace(/_/g, ' ')} · ${(res.tool ?? '').replace(/_/g, ' ')}`, data: res.value })
      }
    }
    return out
  }, [content, effective])

  const inline = (children: React.ReactNode) => renderInlineWithCitations(children, numberMap, effective)

  return (
    <>
      <div className="answer-prose">
        <ReactMarkdown
          components={{
            p: ({ children, ...props }) => <p {...props}>{inline(children)}</p>,
            li: ({ children, ...props }) => <li {...props}>{inline(children)}</li>,
            td: ({ children, ...props }) => <td {...props}>{inline(children)}</td>,
            strong: ({ children, ...props }) => <strong {...props}>{inline(children)}</strong>,
            em: ({ children, ...props }) => <em {...props}>{inline(children)}</em>,
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
      {split.unverified && (
        <aside role="note" className="rounded-md bg-amber-wash px-4 py-3 text-body text-warning" data-testid="unverified-note">
          <p className="font-semibold">Unverified statements</p>
          <div className="answer-prose mt-0.5"><ReactMarkdown>{split.unverified}</ReactMarkdown></div>
        </aside>
      )}
      {split.budget && (
        <aside role="note" className="rounded-md bg-amber-wash px-4 py-3 text-body text-warning" data-testid="budget-note">
          <p className="font-semibold">Run cut short</p>
          <p className="mt-0.5">{split.budget.replace(/\*\*/g, '')}</p>
        </aside>
      )}
      {charts.map((c, i) => <MiniCitationChart key={i} title={c.title} data={c.data} />)}
      {agentCharts?.map((c) => <ChartCard key={c.id} chart={c} />)}
    </>
  )
})

export default CitedMarkdown
