/** Dataset registry: lazily loaded snapshot + a process-wide search index.
 *
 *  Server-side only. The snapshot (~9 MB) is loaded with a dynamic import so it
 *  becomes its own chunk, never part of a client bundle and not parsed until the
 *  first `find_dataset` call.
 */

import { expandEntry, type RegistrySnapshot } from './compact'
import { GOLDEN } from './golden'
import { RegistryIndex, type SearchOptions, type SearchResult } from './search'
import type { DatasetEntry } from './types'

let indexPromise: Promise<RegistryIndex> | null = null

let generatedAt = ''

/** Build (once) and return the search index over the committed snapshot. */
export function getRegistryIndex(): Promise<RegistryIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const mod: any = await import('./snapshot.json')
      const snap = (mod.default ?? mod) as RegistrySnapshot
      generatedAt = snap.generated_at
      const index = new RegistryIndex(snap.entries.map(expandEntry), GOLDEN)
      // Warm the JIT so the first real question is as fast as the rest.
      index.search('elevation model')
      index.search('soil moisture')
      return index
    })().catch((err) => {
      indexPromise = null // allow a retry after a transient failure
      throw err
    })
  }
  return indexPromise
}

export function registryGeneratedAt(): string {
  return generatedAt
}

export async function searchRegistry(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const index = await getRegistryIndex()
  return index.search(query, opts)
}

export async function getRegistryEntry(id: string): Promise<DatasetEntry | undefined> {
  const index = await getRegistryIndex()
  return index.entries.find((e) => e.id === id || e.alternates?.some((a) => a.id === id))
}

export type { SearchHit, SearchOptions, SearchResult, CoverageVerdict } from './search'
export type { DatasetEntry } from './types'
