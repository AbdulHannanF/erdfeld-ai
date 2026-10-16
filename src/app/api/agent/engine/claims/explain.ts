/** The "Explain" narration of a case: built from the recipe's templates and the figures the
 *  ledger recorded, and from nothing else. No model writes it; every sentence that states a
 *  figure carries the id of the result it came from. Pure. */

import { fillTemplate, show, type Decided, type Figure } from './rule'
import type { Recipe, Verdict } from './schema'

export interface ExplainNode {
  step: number
  op: string
  version: string
  resultId: string | null
  status: string
  stats: Record<string, Figure> | null
  /** First line of the result's summary, used only to say why a node has no figures. */
  summary?: string | null
}

export interface ExplainLine {
  text: string
  /** Result ids the sentence rests on (empty for sentences about the recipe or the rule). */
  cites: string[]
}

export const VERDICT_WORDS: Record<Verdict, string> = {
  supported: 'Supported',
  contradicted: 'Contradicted',
  cannot_determine: 'Cannot determine',
}

const scalar = (v: Figure | undefined) => (typeof v === 'number' || typeof v === 'string' ? v : undefined)

export function explainCase(input: {
  recipe: Recipe | null
  recipeRef: string
  params: Record<string, string | number>
  verdict: Verdict
  confidence: number | null
  decision: Pick<Decided, 'rule' | 'reason' | 'kind' | 'inputs'>
  nodes: ExplainNode[]
}): ExplainLine[] {
  const { recipe, nodes } = input
  const lines: ExplainLine[] = []
  const claim = recipe ? fillTemplate(recipe.claim, (n) => scalar(input.params[n])) : 'The claim'
  const verdictText = VERDICT_WORDS[input.verdict] + (input.confidence != null ? ` (confidence ${Math.round(input.confidence * 100)}%, a heuristic score, not a probability)` : '')
  lines.push({ text: `Claim: ${claim} Checked with recipe ${input.recipeRef}. Verdict: ${verdictText}.`, cites: [] })

  for (const node of nodes) {
    const step = recipe?.plan[node.step]
    const id = node.resultId
    if (node.status !== 'ok' || !node.stats) {
      const why = node.status === 'failed' ? 'could not be read; this is a failure, not an absence of data'
        : node.status === 'refused' ? 'was refused before it ran'
        : node.status === 'skipped' ? 'did not run because an earlier step failed'
        : node.status === 'flagged' ? 'ran but failed its own validation'
        : 'produced no figures'
      lines.push({ text: `Step ${node.step} (${node.op}) ${why}.${node.summary ? ` Recorded: ${node.summary}` : ''}`, cites: id ? [id] : [] })
      continue
    }
    if (step?.explain) {
      lines.push({ text: `Step ${node.step} (${node.op}@${node.version}): ${fillTemplate(step.explain, (k) => scalar(node.stats?.[k]))}`, cites: id ? [id] : [] })
    } else {
      const keys = Object.entries(node.stats).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 6)
      lines.push({ text: `Step ${node.step} (${node.op}@${node.version}) recorded ${keys.map(([k, v]) => `${k} ${show(v as number | string)}`).join(', ')}.`, cites: id ? [id] : [] })
    }
  }

  const inputs = Object.entries(input.decision.inputs).filter(([, v]) => v !== null)
  lines.push({
    text: `Decision rule "${input.decision.rule}" applied: ${input.decision.reason}` +
      (inputs.length ? ` Values it used: ${inputs.map(([k, v]) => `${k} = ${show(v as number | string)}`).join(', ')}.` : ''),
    cites: nodes.flatMap((n) => (n.resultId && n.status === 'ok' ? [n.resultId] : [])),
  })
  if (input.verdict === 'cannot_determine' && input.decision.kind) {
    const kind: Record<string, string> = {
      fetch_failed: 'An upstream data source could not be read. Retrying may help; this is not a finding about the plot.',
      data_unavailable: 'The data sources were read and hold nothing usable for this plot and date.',
      insufficient_quality: 'Data exists but too little of it is clear, covering or aligned to decide.',
      out_of_scope: 'The question is outside what this sensor and recipe can resolve.',
      inconclusive: 'The data are clean but the signal is neither clearly for nor against the claim.',
    }
    lines.push({ text: `Why no verdict: ${kind[input.decision.kind] ?? input.decision.kind}`, cites: [] })
  }
  for (const l of recipe?.limitations ?? []) lines.push({ text: `Limit: ${l}`, cites: [] })
  return lines
}
