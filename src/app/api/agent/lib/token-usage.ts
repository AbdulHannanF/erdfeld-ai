/** Token accounting for one run: what each model phase used, as the provider reported it. */

import type { TokenUsage } from './llm-adapters'

export interface PhaseUsage extends TokenUsage {
  /** Model calls in this phase that reported usage. */
  calls: number
}

export const emptyUsage = (): PhaseUsage => ({ calls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0 })

export function addUsage(into: PhaseUsage, u: TokenUsage): void {
  into.calls++
  into.promptTokens += u.promptTokens
  into.outputTokens += u.outputTokens
  into.thoughtTokens += u.thoughtTokens
  into.cachedTokens += u.cachedTokens
}

/** Per phase and in total; `billedInput` = prompt tokens not served from the provider's cache, `billedOutput` = visible + thinking tokens. */
export function tokenTotals(phases: Record<string, PhaseUsage>) {
  const all = Object.values(phases).reduce((a, p) => { addUsage(a, p); a.calls += p.calls - 1; return a }, emptyUsage())
  return {
    ...phases,
    total: { ...all, billedInput: all.promptTokens - all.cachedTokens, billedOutput: all.outputTokens + all.thoughtTokens },
  }
}
