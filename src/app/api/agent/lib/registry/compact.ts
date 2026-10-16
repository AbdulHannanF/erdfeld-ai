/** Compact on-disk form of a `DatasetEntry`.
 *
 *  The snapshot holds ~14k records; repeating a constant licence note or a URL
 *  that is a pure function of the id 14k times is what makes a registry bloated.
 *  `compactEntry` drops every field equal to its derivable default and shortens
 *  keys; `expandEntry` restores the full `DatasetEntry` exactly (round-trip is
 *  unit-tested). The format is an implementation detail of `snapshot.json`.
 */

import type { AccessKind, AuthKind, DatasetAlternate, DatasetEntry, Theme } from './types'
import { DEFAULT_KIND, DEFAULT_NOTES, DEFAULT_PROVIDERS, derivedUrl, sourceInfo } from './sources'
import { isGlobalBbox } from './normalize'

export interface StoredAccess {
  /** kind, omitted when the source default */
  k?: AccessKind
  /** url, omitted when derivable */
  u?: string
  /** requires_auth, omitted when the source default; `0` = explicitly none */
  a?: AuthKind | 0
  /** notes, omitted when the source default */
  n?: string
}

export interface StoredEntry {
  i: string
  t: string
  d?: string
  p?: string[]
  th: Theme[]
  v?: Array<string | [string, string]>
  b: [number, number, number, number]
  /** global flag, only when it differs from what the bbox implies */
  g?: boolean
  s: string | null
  e: string | null
  r?: number
  l?: string
  a?: StoredAccess
  k?: string[]
  c?: 1
  alt?: Array<{ i: string; a: StoredAccess & { k: AccessKind; u: string; a: AuthKind | 0; n: string } }>
}

function sourceOf(id: string): string {
  return id.slice(0, id.indexOf(':'))
}

function compactAccess(source: string, local: string, a: DatasetEntry['access'], themes: readonly string[]): StoredAccess | undefined {
  const out: StoredAccess = {}
  if (a.kind !== (DEFAULT_KIND[source] as AccessKind | undefined)) out.k = a.kind
  if (a.url !== derivedUrl(source, local, themes)) out.u = a.url
  const authDefault = sourceInfo(source)?.auth ?? null
  if (a.requires_auth !== authDefault) out.a = a.requires_auth ?? 0
  if (a.notes !== (DEFAULT_NOTES[source] ?? '')) out.n = a.notes
  return Object.keys(out).length ? out : undefined
}

function expandAccess(source: string, local: string, s: StoredAccess | undefined, themes: readonly string[]): DatasetEntry['access'] {
  return {
    kind: s?.k ?? ((DEFAULT_KIND[source] as AccessKind | undefined) ?? 'stac-other'),
    url: s?.u ?? derivedUrl(source, local, themes) ?? '',
    requires_auth: s?.a === undefined ? (sourceInfo(source)?.auth ?? null) : s.a === 0 ? null : s.a,
    notes: s?.n ?? DEFAULT_NOTES[source] ?? '',
  }
}

export function compactEntry(e: DatasetEntry): StoredEntry {
  const source = e.source
  const local = e.id.slice(source.length + 1)
  const out: StoredEntry = {
    i: e.id, t: e.title, th: e.themes, b: e.spatial.bbox, s: e.temporal.start, e: e.temporal.end,
  }
  if (e.description) out.d = e.description
  const defProv = DEFAULT_PROVIDERS[source]
  if (!(defProv && JSON.stringify(defProv) === JSON.stringify(e.providers)) && e.providers.length) out.p = e.providers
  if (e.variables.length) out.v = e.variables.map((v) => (v.unit ? [v.name, v.unit] as [string, string] : v.name))
  if (e.spatial.global !== isGlobalBbox(e.spatial.bbox)) out.g = e.spatial.global
  if (e.resolution_m !== null) out.r = e.resolution_m
  if (e.license !== 'various') out.l = e.license
  const acc = compactAccess(source, local, e.access, e.themes)
  if (acc) out.a = acc
  if (e.keywords.length) out.k = e.keywords
  if (e.curated) out.c = 1
  if (e.alternates?.length) {
    out.alt = e.alternates.map((x) => ({
      i: x.id,
      a: { k: x.access.kind, u: x.access.url, a: x.access.requires_auth ?? 0, n: x.access.notes },
    }))
  }
  return out
}

export function expandEntry(s: StoredEntry): DatasetEntry {
  const source = sourceOf(s.i)
  const local = s.i.slice(source.length + 1)
  const alternates: DatasetAlternate[] | undefined = s.alt?.map((x) => ({
    source: sourceOf(x.i),
    id: x.i,
    access: { kind: x.a.k, url: x.a.u, requires_auth: x.a.a === 0 ? null : x.a.a, notes: x.a.n },
  }))
  const entry: DatasetEntry = {
    id: s.i,
    title: s.t,
    description: s.d ?? '',
    source,
    providers: s.p ?? DEFAULT_PROVIDERS[source] ?? [],
    themes: s.th,
    variables: (s.v ?? []).map((v) => (Array.isArray(v) ? { name: v[0], unit: v[1] } : { name: v })),
    spatial: { bbox: s.b, global: s.g ?? isGlobalBbox(s.b) },
    temporal: { start: s.s, end: s.e },
    resolution_m: s.r ?? null,
    license: s.l ?? 'various',
    access: expandAccess(source, local, s.a, s.th),
    keywords: s.k ?? [],
  }
  if (s.c) entry.curated = true
  if (alternates) entry.alternates = alternates
  return entry
}

/** The committed `snapshot.json`. */
export interface RegistrySnapshot {
  version: 1
  generated_at: string
  entries: StoredEntry[]
}
