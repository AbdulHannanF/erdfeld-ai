/** Content addressing (ADR-0001 §6). The same operation@version, arguments, AOI and focus give
 *  the same `inputs_hash`; adding the data items actually read gives the `result_id`. The hash is
 *  the cache key and the evidence-ledger entry (persistence is Q-47). */

import { createHash } from 'node:crypto'

/** JSON with sorted keys and no `undefined`, so equal values always serialise equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value))
}

function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonicalise(x)))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = canonicalise(x)
    }
    return out
  }
  return v
}

const COORD_DECIMALS = 1e7

/** Round every number in a GeoJSON geometry to 1e-7 degrees (about 1 cm), so a drawn AOI that
 *  round-trips through the browser keeps its hash. */
export function roundCoords(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * COORD_DECIMALS) / COORD_DECIMALS
  if (Array.isArray(v)) return v.map(roundCoords)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, roundCoords(x)]))
  }
  return v
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface HashInputs {
  op: string
  version: string
  args: Record<string, unknown>
  aoi: unknown
  focus?: { lat: number; lng: number }
}

export function inputsHash(i: HashInputs): string {
  return sha256(canonicalJson({
    op: `${i.op}@${i.version}`,
    args: i.args,
    aoi: roundCoords(i.aoi),
    focus: i.focus ? { lat: i.focus.lat, lng: i.focus.lng } : undefined,
  }))
}

export function resultId(inputsHashHex: string, items: string[]): string {
  return 'r_' + sha256(inputsHashHex + [...items].sort().join('\n')).slice(0, 16)
}
