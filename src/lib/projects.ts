/**
 * P6.1 — Project serialization (pure, framework-free).
 *
 * Bridges the Zustand store's persistable slices (AOI + layers + chat) to the
 * portable DTO shape that `/api/projects` stores and restores. Kept free of
 * Prisma and React imports so it can be unit-tested in isolation and reused by
 * both the API route (DB ↔ DTO) and the store (`loadProject`).
 *
 * Honesty requirement (P6.1): a loaded layer must restore its *original*
 * `provenance` + `confidence` — these functions copy them verbatim and never
 * recompute, so a snapshot stays frozen as captured.
 */

import type { AOI, MapLayer, ChatMessage } from '@/store/useStore'
import { STORAGE_KEYS, readStorage, writeStorage } from '@/lib/storage'

/** The slices of the live store that a saved project captures + restores. */
export interface StoreSnapshot {
  name?: string
  aoi: AOI | null
  mapStyle: string
  layers: MapLayer[]
  messages: ChatMessage[]
}

/** Serializable layer record inside a {@link ProjectDto}. Mirrors the
 *  persistable subset of `MapLayer` (ephemeral/runtime fields excluded). */
export interface LayerDto {
  id: string
  name: string
  type: MapLayer['type']
  tileUrl?: string
  geojson?: GeoJSON.FeatureCollection
  imageBase64?: string
  color?: string
  intensityProperty?: string
  render?: 'extrusion'
  heightProperty?: string
  bounds?: [number, number, number, number]
  palette?: MapLayer['palette']
  provenance?: MapLayer['provenance']
  confidence?: MapLayer['confidence']
  resultId?: string
  tool?: string
  summaryData?: MapLayer['summaryData']
  aoiKey?: string
  opacity: number
  visible: boolean
}

/** Serializable chat message inside a {@link ProjectDto}. */
export interface MessageDto {
  id: string
  role: ChatMessage['role']
  content: string
  resultId?: string
  toolResults?: ChatMessage['toolResults']
}

/** The portable project payload — POSTed on save, returned by `GET /:id`. */
export interface ProjectDto {
  name: string
  aoi: AOI | null
  mapStyle: string
  layers: LayerDto[]
  messages: MessageDto[]
}

const DEFAULT_PROJECT_NAME = 'Untitled project'

/** Drop `undefined`-valued keys so the DTO round-trips to deep-equal JSON. */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}

/** Flatten the live store slices into a persistable DTO (whitelist fields so a
 *  future ephemeral `MapLayer` field never accidentally gets persisted). */
export function toDto(snapshot: StoreSnapshot): ProjectDto {
  return {
    name: snapshot.name?.trim() || DEFAULT_PROJECT_NAME,
    aoi: snapshot.aoi ?? null,
    mapStyle: snapshot.mapStyle,
    layers: snapshot.layers.map((l) =>
      compact<LayerDto>({
        id: l.id,
        name: l.name,
        type: l.type,
        tileUrl: l.tileUrl,
        geojson: l.geojson,
        imageBase64: l.imageBase64,
        color: l.color,
        intensityProperty: l.intensityProperty,
        render: l.render,
        heightProperty: l.heightProperty,
        bounds: l.bounds,
        palette: l.palette,
        provenance: l.provenance,
        confidence: l.confidence,
        resultId: l.resultId,
        tool: l.tool,
        summaryData: l.summaryData,
        aoiKey: l.aoiKey,
        opacity: l.opacity,
        visible: l.visible,
      }),
    ),
    messages: snapshot.messages
      // Only persist messages with real content (skip the empty placeholder
      // bubble that the streaming UI mounts before tokens arrive).
      .filter((m) => m.content)
      .map((m) =>
        compact<MessageDto>({
          id: m.id,
          role: m.role,
          content: m.content,
          toolResults: m.toolResults,
        }),
      ),
  }
}

/** Rebuild the store-ready pieces from a DTO. Layers/messages come back as the
 *  exact `MapLayer` / `ChatMessage` shapes the store actions expect. */
export function fromDto(dto: ProjectDto): {
  aoi: AOI | null
  mapStyle: string
  layers: MapLayer[]
  messages: ChatMessage[]
} {
  return {
    aoi: dto.aoi ?? null,
    mapStyle: dto.mapStyle,
    layers: (dto.layers ?? []).map((l) =>
      compact<MapLayer>({
        id: l.id,
        name: l.name,
        type: l.type,
        tileUrl: l.tileUrl,
        geojson: l.geojson,
        imageBase64: l.imageBase64,
        color: l.color,
        intensityProperty: l.intensityProperty,
        render: l.render,
        heightProperty: l.heightProperty,
        bounds: l.bounds,
        palette: l.palette,
        provenance: l.provenance,
        confidence: l.confidence,
        resultId: l.resultId,
        tool: l.tool,
        summaryData: l.summaryData,
        aoiKey: l.aoiKey,
        visible: l.visible ?? true,
        opacity: l.opacity ?? 1,
      } as MapLayer),
    ),
    messages: (dto.messages ?? []).map((m) =>
      compact<ChatMessage>({
        id: m.id,
        role: m.role,
        content: m.content,
        toolResults: m.toolResults,
        timestamp: Date.now(),
      } as ChatMessage),
    ),
  }
}

/** Stable per-browser anonymous owner key (until P6.3 wires real auth). Returns
 *  '' on the server so it never breaks SSR; the client generates + persists one
 *  on first use. */
export function getOwnerToken(): string {
  if (typeof window === 'undefined') return ''
  try {
    let token = readStorage(STORAGE_KEYS.ownerToken)
    if (!token) {
      token =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`
      writeStorage(STORAGE_KEYS.ownerToken, token)
    }
    return token
  } catch {
    return ''
  }
}

/** Summary row returned by `GET /api/projects` (list view). */
export interface ProjectSummary {
  id: string
  name: string
  layerCount: number
  messageCount: number
  updatedAt: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// P6.2 — shareable read-only links
// ---------------------------------------------------------------------------

/** Whether `requester` may read/mutate/share a project whose stored owner token
 *  is `projectToken`. Anonymous/legacy projects (null token) stay open so old
 *  rows aren't orphaned; otherwise the tokens must match. Shared by every
 *  `/api/projects*` handler (no parallel copies of the rule). */
export function canAccessProject(projectToken: string | null | undefined, requester: string): boolean {
  if (!projectToken) return true
  return projectToken === requester
}

/** URL-safe, unambiguous alphabet (no 0/O/1/l/I) for short share tokens. */
const SHARE_TOKEN_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * Generate a short, readable share token (default 8 chars). `randomInt` is
 * injectable so the generator is deterministically testable; the route passes a
 * crypto-backed source. Collisions are handled at the DB layer (token is a PK —
 * the route retries on a unique-constraint hit).
 */
export function generateShareToken(
  length = 8,
  randomInt: (maxExclusive: number) => number = (max) => Math.floor(Math.random() * max),
): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += SHARE_TOKEN_ALPHABET[randomInt(SHARE_TOKEN_ALPHABET.length)]
  }
  return out
}

/** True when a token only contains characters from the share alphabet and is a
 *  sane length — cheap guard before a DB lookup on `GET /api/share/:token`. */
export function isValidShareToken(token: string): boolean {
  if (typeof token !== 'string' || token.length < 4 || token.length > 24) return false
  for (const ch of token) {
    if (!SHARE_TOKEN_ALPHABET.includes(ch)) return false
  }
  return true
}

/** Payload returned by `GET /api/share/:token` — the frozen project snapshot
 *  plus the timestamps the read-only banner / legend surface as provenance. */
export interface SharedProjectDto {
  token: string
  projectId: string
  name: string
  /** Project creation time (ISO). */
  createdAt: string
  /** Last time the owner saved the project (ISO) — "snapshot of …". */
  updatedAt: string
  /** When the share link was minted (ISO). */
  sharedAt: string
  viewCount: number
  project: ProjectDto
}
