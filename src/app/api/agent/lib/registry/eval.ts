/** Retrieval evaluation helpers (used by the vitest suite and the ad-hoc runner). */

import type { DatasetEntry } from './types'

export interface EvalQuestion {
  theme: string
  q: string
  /** Acceptable entry ids. `*` matches any run of characters (family globs only). */
  acceptable: string[]
  aoi?: [number, number, number, number]
  time?: { start?: string; end?: string }
}

const RE_CACHE = new Map<string, RegExp>()

function globToRegex(glob: string): RegExp {
  let re = RE_CACHE.get(glob)
  if (!re) {
    re = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
    RE_CACHE.set(glob, re)
  }
  return re
}

/** True when the entry (or any merged alternate route) matches an acceptable id/glob. */
export function isAcceptable(entry: DatasetEntry, acceptable: string[]): boolean {
  const ids = [entry.id, ...(entry.alternates ?? []).map((a) => a.id)]
  return acceptable.some((p) => ids.some((id) => (p.includes('*') ? globToRegex(p).test(id) : id.toLowerCase() === p.toLowerCase())))
}

export interface ThemeScore { theme: string; n: number; hits: number }

export function hitAtK(ranked: DatasetEntry[], acceptable: string[], k = 5): boolean {
  return ranked.slice(0, k).some((e) => isAcceptable(e, acceptable))
}

export function perTheme(results: Array<{ theme: string; hit: boolean }>): ThemeScore[] {
  const m = new Map<string, ThemeScore>()
  for (const r of results) {
    const s = m.get(r.theme) ?? { theme: r.theme, n: 0, hits: 0 }
    s.n++
    if (r.hit) s.hits++
    m.set(r.theme, s)
  }
  return [...m.values()].sort((a, b) => a.theme.localeCompare(b.theme))
}
