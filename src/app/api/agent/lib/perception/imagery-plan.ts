/** ② Imagery planner — the coarsest source that still resolves the target
 *  (v2 spec §3.3).
 *
 *  > Pick the coarsest source that still resolves the target, escalating only
 *  > when needed. […] The planner must detect placeholder tiles and stop
 *  > escalating. When nothing in the registry resolves the target, the pipeline
 *  > says so and names what would.
 *
 *  Two measurements shape this module, both taken live on 2026-08-10:
 *
 *  **The escalation ceiling belongs to the location, not the provider.** Esri
 *  World Imagery served real pixels up to z18 over the Sahara, z19 over Lahore,
 *  z20 over Manhattan and z21 over Amsterdam. Any planner carrying one global
 *  "max zoom" is wrong nearly everywhere, so the ceiling is *probed*.
 *
 *  **The placeholder is byte-identical worldwide** — 2,521 bytes, SHA-256
 *  `9eafd300…b858`, verified identical from two unrelated tiles. That makes the
 *  test exact rather than a size heuristic, which matters because a real tile can
 *  legitimately be 2,521 bytes long.
 *
 *  Resolution is physics: a 0.3 m object is ~1 px at 0.3 m/px and no model
 *  recovers it. This module is where that gets said out loud instead of being
 *  discovered as a silent zero three stages later.
 */

import { createHash } from 'crypto'

/** Web-Mercator ground resolution at the equator, zoom 0, 256 px tiles. */
const EQUATOR_MPP = 156543.03392804097

/** Measured signature of the Esri "no imagery here" tile. */
export const ESRI_PLACEHOLDER_BYTES = 2521
export const ESRI_PLACEHOLDER_SHA256 =
  '9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858'

/** Ground resolution in metres/pixel at a latitude and zoom. */
export function metersPerPixel(lat: number, zoom: number, tilePx = 256): number {
  return (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / (tilePx / 256)
}

/** How many pixels an object of `footprintM` spans at this latitude and zoom. */
export function objectPixelsAt(footprintM: number, lat: number, zoom: number, tilePx = 256): number {
  return footprintM / metersPerPixel(lat, zoom, tilePx)
}

/**
 * The COARSEST zoom at which the object still spans `minPx`.
 *
 * Coarsest, not finest: a coarser tile covers more ground, so fewer tiles cover
 * the AOI and the analysis is cheaper. Escalation happens only when this zoom
 * turns out to have no imagery.
 */
export function zoomForObjectPixels(footprintM: number, lat: number, minPx: number, tilePx = 256): number {
  const needed = (minPx * EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / (footprintM * (tilePx / 256))
  return Math.ceil(Math.log2(needed))
}

/** True only for the exact placeholder bytes. Size alone never convicts. */
export function isPlaceholderTile(bytes: Buffer | Uint8Array | ArrayBuffer): boolean {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as any)
  if (buf.length !== ESRI_PLACEHOLDER_BYTES) return false
  return createHash('sha256').update(buf).digest('hex') === ESRI_PLACEHOLDER_SHA256
}

// ---------------------------------------------------------------------------
// Registry — only what we can actually fetch
// ---------------------------------------------------------------------------

export interface ImagerySource {
  id: string
  name: string
  /** XYZ template with `{z}` `{x}` `{y}`. */
  urlTemplate: string
  minZoom: number
  maxZoom: number
  /** Best-case native ground resolution, m/px — used for ordering and honesty. */
  bestResolutionM: number
  attribution: string
  licence: string
}

/**
 * Fetchable imagery, coarsest first.
 *
 * Deliberately short: a registry entry is a promise that the app can retrieve
 * those pixels. NAIP, PDOK, OpenAerialMap and Maxar are real and finer, but they
 * are not wired here — listing them as sources would be a capability claim we
 * cannot honour, so they live in `KNOWN_FINER_SOURCES` and are only ever *named*
 * as what would resolve a target we cannot.
 */
export const IMAGERY_REGISTRY: ImagerySource[] = [
  {
    id: 'esri-world-imagery',
    name: 'Esri World Imagery',
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 23,
    bestResolutionM: 0.3,
    attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    licence: 'Esri World Imagery terms — free for non-commercial and evaluation use',
  },
]

interface FinerSource {
  name: string
  resolutionM: number
  /** Rough coverage test — lon/lat bounds, or null for global. */
  covers: null | ((lat: number, lon: number) => boolean)
  note: string
}

/** Real, finer imagery that exists but is not wired. Used only to name options. */
const KNOWN_FINER_SOURCES: FinerSource[] = [
  {
    name: 'USDA NAIP',
    resolutionM: 0.6,
    covers: (lat, lon) => lat > 24 && lat < 50 && lon > -125 && lon < -66,
    note: '0.6 m (often 0.3 m) aerial orthophotography over the conterminous United States.',
  },
  {
    name: 'PDOK Luchtfoto (Netherlands)',
    resolutionM: 0.08,
    covers: (lat, lon) => lat > 50.7 && lat < 53.6 && lon > 3.2 && lon < 7.3,
    note: '8 cm national orthophoto — fine enough for street furniture.',
  },
  {
    name: 'OpenAerialMap',
    resolutionM: 0.1,
    covers: null,
    note: 'Community drone and aerial surveys; coverage is patchy but often 5–20 cm where it exists.',
  },
  {
    name: 'Maxar Open Data',
    resolutionM: 0.3,
    covers: null,
    note: 'Released for disaster events only — check whether this AOI has an activation.',
  },
  {
    name: 'Mapillary street-level',
    resolutionM: 0.01,
    covers: null,
    note: 'Ground-level photography; the only realistic way to see objects below ~0.5 m.',
  },
]

/** Name the finer imagery that would resolve a target here. */
export function describeFinerSources(lat: number, lon: number, neededMpp?: number): string {
  const applicable = KNOWN_FINER_SOURCES.filter(
    (s) => (!s.covers || s.covers(lat, lon)) && (neededMpp == null || s.resolutionM <= neededMpp * 1.5),
  )
  const list = applicable.length ? applicable : KNOWN_FINER_SOURCES.filter((s) => !s.covers)
  return list.map((s) => `**${s.name}** (~${s.resolutionM} m) — ${s.note}`).join(' ')
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Result of one probe fetch. */
export type ProbeResult = Buffer | Uint8Array | { placeholder: true }

export interface PlanImageryOptions {
  lat: number
  lon: number
  /** Long axis of the target in metres; null when the profiler could not size it. */
  footprintM: number | null
  /** Pixels across the long axis the downstream detector needs. */
  minPx: number
  sources?: ImagerySource[]
  /** Injected tile fetch — `(url, zoom) => bytes`. Throwing means "unreachable". */
  fetchTile: (url: string, zoom: number) => Promise<ProbeResult>
}

export interface ImageryProbe {
  zoom: number
  placeholder: boolean
  bytes?: number
}

export interface ImageryPlan {
  ok: boolean
  source?: ImagerySource
  /** Zoom to analyse at. */
  zoom?: number
  /** Ground resolution at that zoom. */
  mpp?: number
  /** How many pixels the target spans there. */
  objectPx?: number
  /** Finest zoom found to carry real imagery at this location. */
  ceilingZoom?: number
  ceilingMpp?: number
  probes: ImageryProbe[]
  /** Why the plan failed — never empty when `ok` is false. */
  reason?: string
  /** What WOULD resolve the target. Always set when the limit is resolution. */
  wouldNeed?: string
}

/** How far above the required zoom we are willing to hunt for imagery. */
const MAX_ESCALATION_STEPS = 3

function tileUrl(source: ImagerySource, z: number, lat: number, lon: number): string {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return source.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

/**
 * Choose imagery for a target, probing the location's real ceiling.
 *
 * Never reports "no imagery" for a network failure: a fetch that throws is an
 * unreachable provider, which is a different answer from "this place has no
 * imagery at this zoom", and conflating them would tell a user their city is
 * unmapped because a proxy hiccuped.
 */
export async function planImagery(opts: PlanImageryOptions): Promise<ImageryPlan> {
  const { lat, lon, footprintM, minPx, fetchTile } = opts
  const sources = opts.sources ?? IMAGERY_REGISTRY
  const probes: ImageryProbe[] = []

  if (footprintM == null || !(footprintM > 0)) {
    return {
      ok: false,
      probes,
      reason:
        'No physical size is known for this target, so no imagery resolution can be judged ' +
        'sufficient. Give an approximate footprint in metres and the plan can be made.',
    }
  }

  for (const source of sources) {
    const required = zoomForObjectPixels(footprintM, lat, minPx)
    const startZoom = Math.max(source.minZoom, required)
    if (startZoom > source.maxZoom) continue

    let ceilingZoom: number | null = null

    // Try the coarsest zoom that resolves, then escalate a bounded number of
    // steps. Escalation only helps when the coarse probe was a placeholder but a
    // finer one is not — which does happen, since providers stitch coverage at
    // different levels.
    for (let z = startZoom; z <= Math.min(source.maxZoom, startZoom + MAX_ESCALATION_STEPS); z++) {
      let result: ProbeResult
      try {
        result = await fetchTile(tileUrl(source, z, lat, lon), z)
      } catch (err: any) {
        return {
          ok: false,
          probes,
          reason:
            `Could not reach ${source.name} to check imagery coverage: ${err?.message ?? 'unreachable'}. ` +
            `This is a provider failure, not a statement about what imagery exists here.`,
        }
      }

      const placeholder = !Buffer.isBuffer(result) && !(result instanceof Uint8Array)
        ? true
        : isPlaceholderTile(result as any)
      const bytes = Buffer.isBuffer(result) || result instanceof Uint8Array ? (result as any).length : undefined
      probes.push({ zoom: z, placeholder, bytes })

      if (!placeholder) {
        return {
          ok: true,
          source,
          zoom: z,
          mpp: metersPerPixel(lat, z),
          objectPx: objectPixelsAt(footprintM, lat, z),
          ceilingZoom: z,
          ceilingMpp: metersPerPixel(lat, z),
          probes,
        }
      }
      ceilingZoom = null
    }

    // Everything at or above the required zoom was a placeholder. Walk down to
    // find where imagery actually stops, so the report can state the real limit.
    for (let z = startZoom - 1; z >= source.minZoom && z >= startZoom - 6; z--) {
      let result: ProbeResult
      try {
        result = await fetchTile(tileUrl(source, z, lat, lon), z)
      } catch {
        break
      }
      const placeholder = !Buffer.isBuffer(result) && !(result instanceof Uint8Array)
        ? true
        : isPlaceholderTile(result as any)
      probes.push({ zoom: z, placeholder, bytes: (result as any)?.length })
      if (!placeholder) { ceilingZoom = z; break }
    }

    if (ceilingZoom != null) {
      const ceilingMpp = metersPerPixel(lat, ceilingZoom)
      const actualPx = objectPixelsAt(footprintM, lat, ceilingZoom)
      const neededMpp = footprintM / minPx
      return {
        ok: false,
        source,
        ceilingZoom,
        ceilingMpp,
        probes,
        reason:
          `${source.name} carries imagery here only to z${ceilingZoom} (~${ceilingMpp.toFixed(2)} m/px). ` +
          `A ${footprintM} m target spans about ${actualPx.toFixed(0)} px there, below the ${minPx} px ` +
          `needed to resolve it. Finer zooms return the provider's blank placeholder tile, not imagery.`,
        wouldNeed:
          `Resolving a ${footprintM} m object needs about **${neededMpp.toFixed(2)} m/px** or better ` +
          `(${(ceilingMpp / neededMpp).toFixed(1)}× finer than what is available here). ` +
          describeFinerSources(lat, lon, neededMpp),
      }
    }
  }

  const neededMpp = footprintM / minPx
  return {
    ok: false,
    probes,
    reason:
      `No registered imagery source resolves a ${footprintM} m target at this location ` +
      `(${lat.toFixed(4)}, ${lon.toFixed(4)}).`,
    wouldNeed:
      `This needs about **${neededMpp.toFixed(2)} m/px** or better. ` + describeFinerSources(lat, lon, neededMpp),
  }
}
