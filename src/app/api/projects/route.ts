/**
 * P6.1 / C1 — Projects collection endpoint.
 *
 *   GET  /api/projects   → list this owner's saved projects (summaries).
 *   POST /api/projects   → create a project from a {@link ProjectDto}; returns { id }.
 *
 * Owner scoping (C1): the signed-in account (`account:<id>`) when authenticated, else
 * the anonymous `x-owner-token` header (localStorage-backed). Anonymous use unchanged.
 * No SSE here — plain JSON.
 */

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import type { ProjectDto, ProjectSummary } from '@/lib/projects'
import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, ProjectCreateSchema, parseBody } from '@/lib/api-schemas'
import { getLogger } from '../agent/lib/logger'
import { projectCreateData } from '../projects/serialize'

export const dynamic = 'force-dynamic'

const log = getLogger('api/projects')

export async function GET(req: NextRequest) {
  const owner = await getRequestOwner(req)
  // Anonymous, no token → nothing to list (avoids leaking every saved project).
  if (!owner) return NextResponse.json({ projects: [] })

  try {
    const rows = await db.project.findMany({
      where: { ownerToken: owner },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { layers: true, messages: true } },
      },
    })
    const projects: ProjectSummary[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      layerCount: r._count.layers,
      messageCount: r._count.messages,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    return NextResponse.json({ projects })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'list failed')
    return NextResponse.json({ error: 'Failed to list projects' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const owner = await getRequestOwner(req)
  const parsed = await parseBody(req, ProjectCreateSchema, { max: BODY_LIMITS.project })
  if (!parsed.ok) return parsed.response

  const body = parsed.data
  const dto = {
    name: body.name || 'Untitled project',
    aoi: body.aoi ?? null,
    mapStyle: body.mapStyle ?? 'dark',
    layers: body.layers ?? [],
    messages: body.messages ?? [],
  } as ProjectDto

  try {
    const created = await db.project.create({
      data: projectCreateData(dto, owner || null),
      select: { id: true, name: true, updatedAt: true },
    })
    return NextResponse.json(
      { id: created.id, name: created.name, updatedAt: created.updatedAt.toISOString() },
      { status: 201 },
    )
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'create failed')
    return NextResponse.json({ error: 'Failed to save project' }, { status: 500 })
  }
}
