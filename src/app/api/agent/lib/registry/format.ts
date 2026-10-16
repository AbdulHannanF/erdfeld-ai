/** Human/LLM-readable rendering of registry hits for the `find_dataset` tool. */

import type { SearchHit } from './search'
import { sourceInfo } from './sources'
import { readability } from './readers/routing'
import type { AuthKind, DatasetEntry } from './types'

export function formatResolution(m: number | null): string {
  if (m === null) return 'resolution not stated'
  if (m >= 1000) return `~${+(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`
  if (m >= 1) return `~${Math.round(m)} m`
  return `~${Math.round(m * 100)} cm`
}

export function formatTemporal(e: DatasetEntry): string {
  const { start, end } = e.temporal
  if (!start && !end) return 'period not stated'
  if (start && !end) return `${start.slice(0, 10)} to present`
  return `${start ? start.slice(0, 10) : '?'} to ${end!.slice(0, 10)}`
}

const AUTH_LABEL: Record<AuthKind, string> = {
  earthdata: 'NASA Earthdata login',
  earthengine: 'Earth Engine account',
  copernicus: 'Copernicus Data Space account',
  opentopography: 'OpenTopography API key',
  'api-key': 'a free API key',
}

export function formatAuth(entry: DatasetEntry, available: boolean | null): string {
  const need = entry.access.requires_auth
  if (!need) return 'no auth needed'
  return `needs ${AUTH_LABEL[need]} (${available ? 'configured here' : 'NOT configured here'})`
}

export function formatCoverage(hit: SearchHit): string {
  switch (hit.coverage) {
    case 'global': return 'global coverage'
    case 'covers': return 'declared extent covers the AOI'
    case 'partial': return 'declared extent only partly covers the AOI'
    default: return 'coverage not checked (no AOI)'
  }
}

/** The `use_dataset` call for this entry: every registry entry has one, and the reader says what it can do. */
export function readCallFor(entry: DatasetEntry): string {
  return `use_dataset({dataset_id: "${entry.id}"})`
}

export function formatHit(hit: SearchHit, rank: number): string {
  const e = hit.entry
  const src = sourceInfo(e.source)?.name ?? e.source
  const alt = (e.alternates ?? []).map((a) => a.source)
  const rd = readability(e, () => hit.authAvailable === true)
  const call = readCallFor(e)
  const use =
    rd.state === 'readable' ? `   · to read it now: \`${call}\``
    : rd.state === 'auth' || rd.state === 'info-only' ? `   · \`${call}\`: ${rd.note}`
    : `   · not readable by \`use_dataset\` in-app yet: ${rd.note} (route: ${e.access.url})`
  return [
    `${rank}. **${e.title}** — \`${e.id}\`${hit.golden ? ' ★' : ''}`,
    `   · themes: ${e.themes.join(', ') || 'none'} · ${formatResolution(e.resolution_m)} · ${formatTemporal(e)}`,
    `   · ${formatCoverage(hit)} · licence: ${e.license}`,
    `   · access: ${e.access.kind} via ${src}${alt.length ? ` (also: ${[...new Set(alt)].join(', ')})` : ''} · ${formatAuth(e, hit.authAvailable)}`,
    use,
  ].join('\n')
}
