'use server'

/**
 * The Data catalog's search: a server action over the offline dataset registry, the same index
 * `find_dataset` ranks against (src/app/api/agent/lib/registry). It is a server action, not a
 * route, because the registry is a ~9 MB snapshot that must never reach the browser; the page
 * receives only the few rows it shows. Nothing here calls out to the network.
 */
import { getRegistryIndex, registryGeneratedAt, searchRegistry } from '@/app/api/agent/lib/registry'
import { THEMES, type Theme } from '@/app/api/agent/lib/registry/types'

export interface CatalogRow {
  id: string
  title: string
  description: string
  source: string
  providers: string[]
  themes: string[]
  resolutionM: number | null
  temporal: { start: string | null; end: string | null }
  license: string
  access: { kind: string; url: string; requiresAuth: string | null; notes: string }
  /** global | covers | partial | unknown, against the area passed in. */
  coverage: string
  curated: boolean
  /** Whether `use_dataset` can read this kind of source in the app. */
  authAvailable: boolean | null
}

export interface CatalogAnswer {
  rows: CatalogRow[]
  matched: number
  afterFilters: number
  total: number
  generatedAt: string
  unknownTerms: string[]
}

export interface CatalogQuery {
  query: string
  theme?: string
  /** [west, south, east, north] of the drawn area, to state coverage against it. */
  aoi?: [number, number, number, number]
  limit?: number
}

const bboxOk = (b: unknown): b is [number, number, number, number] =>
  Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n))

export async function searchCatalog(q: CatalogQuery): Promise<CatalogAnswer> {
  const index = await getRegistryIndex()
  const query = String(q.query ?? '').slice(0, 200).trim()
  const limit = Math.min(Math.max(Number(q.limit) || 12, 1), 25)
  const themes = q.theme && (THEMES as readonly string[]).includes(q.theme) ? [q.theme as Theme] : undefined
  const base = { limit, themes, aoi: bboxOk(q.aoi) ? q.aoi : undefined }
  const res = query ? await searchRegistry(query, base) : null
  const rows = (res?.hits ?? []).map((h) => ({
    id: h.entry.id,
    title: h.entry.title,
    description: h.entry.description,
    source: h.entry.source,
    providers: h.entry.providers.slice(0, 4),
    themes: h.entry.themes,
    resolutionM: h.entry.resolution_m,
    temporal: h.entry.temporal,
    license: h.entry.license,
    access: { kind: h.entry.access.kind, url: h.entry.access.url, requiresAuth: h.entry.access.requires_auth, notes: h.entry.access.notes },
    coverage: h.coverage,
    curated: !!h.entry.curated,
    authAvailable: h.authAvailable,
  }))
  return {
    rows,
    matched: res?.matched ?? 0,
    afterFilters: res?.afterFilters ?? 0,
    total: index.entries.length,
    generatedAt: registryGeneratedAt(),
    unknownTerms: res?.unknownTerms ?? [],
  }
}

/** How many datasets the registry holds, and when it was harvested. */
export async function catalogSize(): Promise<{ total: number; generatedAt: string }> {
  const index = await getRegistryIndex()
  return { total: index.entries.length, generatedAt: registryGeneratedAt() }
}
