/**
 * P6.1 — server-only mapping between Prisma rows and the portable
 * {@link ProjectDto}. Structured fields are `Json` (jsonb) columns; this is where
 * they are typed on the way out and null-handled on the way in.
 */

import { Prisma, type Layer, type Message, type Project } from '@prisma/client'
import type { AOI } from '@/store/useStore'
import type { LayerDto, MessageDto, ProjectDto } from '@/lib/projects'

/** Read a nullable `Json` column; null becomes undefined. The stored value is trusted to be the
 *  shape that was written (the DTO), as it was when it was JSON text. */
function parseJson<T>(v: Prisma.JsonValue | null): T | undefined {
  return v == null ? undefined : (v as T)
}

/** A value for a nullable `Json` column; null and undefined become SQL NULL. */
export function toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue)
}

type ProjectWithRelations = Project & { layers: Layer[]; messages: Message[] }

/** Prisma row (with relations) → portable DTO. */
export function dbToDto(p: ProjectWithRelations): ProjectDto {
  return {
    name: p.name,
    aoi: parseJson<AOI>(p.aoi) ?? null,
    mapStyle: p.mapStyle ?? 'dark',
    layers: [...p.layers]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(
        (l): LayerDto => ({
          id: l.layerId,
          name: l.name,
          type: l.type as LayerDto['type'],
          ...(l.tileUrl ? { tileUrl: l.tileUrl } : {}),
          ...(l.geojson ? { geojson: parseJson<GeoJSON.FeatureCollection>(l.geojson) } : {}),
          ...(l.imageBase64 ? { imageBase64: l.imageBase64 } : {}),
          ...(l.color ? { color: l.color } : {}),
          ...(l.intensityProperty ? { intensityProperty: l.intensityProperty } : {}),
          ...(l.render ? { render: l.render as 'extrusion' } : {}),
          ...(l.heightProperty ? { heightProperty: l.heightProperty } : {}),
          ...(l.bounds ? { bounds: parseJson<[number, number, number, number]>(l.bounds) } : {}),
          ...(l.palette ? { palette: parseJson<LayerDto['palette']>(l.palette) } : {}),
          ...(l.provenance ? { provenance: parseJson<LayerDto['provenance']>(l.provenance) } : {}),
          ...(l.confidence ? { confidence: l.confidence as LayerDto['confidence'] } : {}),
          ...(l.resultId ? { resultId: l.resultId } : {}),
          ...(l.tool ? { tool: l.tool } : {}),
          ...(l.summaryData ? { summaryData: parseJson<LayerDto['summaryData']>(l.summaryData) } : {}),
          ...(l.aoiKey ? { aoiKey: l.aoiKey } : {}),
          opacity: l.opacity,
          visible: l.visible,
        }),
      ),
    messages: [...p.messages]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(
        (m): MessageDto => ({
          id: m.id,
          role: m.role as MessageDto['role'],
          content: m.content,
          ...(m.resultId ? { resultId: m.resultId } : {}),
          ...(m.toolResults ? { toolResults: parseJson<MessageDto['toolResults']>(m.toolResults) } : {}),
        }),
      ),
  }
}

/** DTO layer → Prisma nested-create input. */
export function layerCreateData(l: LayerDto, sortOrder: number): Prisma.LayerCreateWithoutProjectInput {
  return {
    layerId: l.id,
    name: l.name,
    type: l.type,
    tileUrl: l.tileUrl ?? null,
    geojson: toJson(l.geojson),
    imageBase64: l.imageBase64 ?? null,
    color: l.color ?? null,
    intensityProperty: l.intensityProperty ?? null,
    render: l.render ?? null,
    heightProperty: l.heightProperty ?? null,
    bounds: toJson(l.bounds),
    palette: toJson(l.palette),
    provenance: toJson(l.provenance),
    confidence: l.confidence ?? null,
    resultId: l.resultId ?? null,
    tool: l.tool ?? null,
    summaryData: toJson(l.summaryData),
    aoiKey: l.aoiKey ?? null,
    opacity: typeof l.opacity === 'number' ? l.opacity : 1,
    visible: l.visible ?? true,
    sortOrder,
  }
}

/** DTO message → Prisma nested-create input. */
export function messageCreateData(m: MessageDto, sortOrder: number): Prisma.MessageCreateWithoutProjectInput {
  return {
    role: m.role,
    content: m.content,
    resultId: m.resultId ?? null,
    toolResults: toJson(m.toolResults),
    sortOrder,
  }
}

/** Build the full nested-create payload for a new project. */
export function projectCreateData(
  dto: ProjectDto,
  ownerToken: string | null,
): Prisma.ProjectCreateInput {
  return {
    name: dto.name?.trim() || 'Untitled project',
    ownerToken: ownerToken || null,
    aoi: toJson(dto.aoi),
    mapStyle: dto.mapStyle ?? 'dark',
    layers: { create: (dto.layers ?? []).map((l, i) => layerCreateData(l, i)) },
    messages: { create: (dto.messages ?? []).map((m, i) => messageCreateData(m, i)) },
  }
}
