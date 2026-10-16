'use client'

import { useEffect, useState } from 'react'
import { GeoResultSchema, type GeoResult } from '@/lib/geo-result'
import { getOwnerToken } from '@/lib/projects'

/**
 * The stored GeoResult behind a result id (`GET /api/results/:id`): its uncertainty ranges and
 * notes and its validation checks, which the live event stream does not carry. Content-addressed,
 * so a result never changes and is cached for the page's life. `undefined` while loading and for
 * a result that is not stored or not readable; callers then simply have no range to show.
 */
const cache = new Map<string, GeoResult | null>()
const inflight = new Map<string, Promise<void>>()
const MAX = 12

async function load(id: string) {
  try {
    const res = await fetch(`/api/results/${encodeURIComponent(id)}`, { headers: { 'x-owner-token': getOwnerToken() } })
    if (!res.ok) {
      cache.set(id, null)
      return
    }
    const body = (await res.json()) as { result?: unknown }
    const parsed = GeoResultSchema.safeParse(body.result)
    cache.set(id, parsed.success ? parsed.data : null)
  } catch {
    // a network error is not cached as "missing": the next render may try again
  }
}

export function useResultDetails(ids: string[]): Record<string, GeoResult | undefined> {
  const [, bump] = useState(0)
  const key = ids.slice(0, MAX).join('|')
  useEffect(() => {
    let live = true
    const wanted = key ? key.split('|') : []
    const pending = wanted.filter((id) => !cache.has(id))
    if (pending.length === 0) return
    Promise.all(
      pending.map((id) => {
        let p = inflight.get(id)
        if (!p) {
          p = load(id).finally(() => inflight.delete(id))
          inflight.set(id, p)
        }
        return p
      }),
    ).then(() => {
      if (live) bump((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [key])

  const out: Record<string, GeoResult | undefined> = {}
  for (const id of key ? key.split('|') : []) {
    const r = cache.get(id)
    if (r) out[id] = r
  }
  return out
}
