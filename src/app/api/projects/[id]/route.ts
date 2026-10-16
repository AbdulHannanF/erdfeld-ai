/**
 * P6.1 — Single-project endpoint.
 *
 *   GET    /api/projects/:id  → full {@link ProjectDto} for restoration.
 *   PATCH  /api/projects/:id  → rename and/or replace state (AOI + layers + chat).
 *   DELETE /api/projects/:id  → remove the project (cascades layers + messages).
 *
 * Ownership (C1): a project with an `ownerToken` is only mutable/readable by a
 * request resolving to the matching owner key — the signed-in account
 * (`account:<id>`) when authenticated, else the anonymous `x-owner-token`. Legacy/
 * anonymous projects (null token) stay open so existing rows aren't orphaned.
 */

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { canAccessProject, type ProjectDto } from '@/lib/projects'
import { getRequestOwner } from '@/lib/auth'
import { BODY_LIMITS, ProjectIdParams, ProjectPatchSchema, parseBody, validate } from '@/lib/api-schemas'
import { getLogger } from '../../agent/lib/logger'
import { dbToDto, layerCreateData, messageCreateData, toJson } from '../serialize'

export const dynamic = 'force-dynamic'

const log = getLogger('api/projects/[id]')

/** True when `owner` may access a project whose stored token is `projectToken`. */
function canAccess(projectToken: string | null, owner: string): boolean {
  return canAccessProject(projectToken, owner)
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = validate(ProjectIdParams, await params)
  if (!p.ok) return p.response
  const { id } = p.data
  try {
    const project = await db.project.findUnique({
      where: { id },
      include: { layers: true, messages: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!canAccess(project.ownerToken, (await getRequestOwner(req)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({
      id: project.id,
      updatedAt: project.updatedAt.toISOString(),
      createdAt: project.createdAt.toISOString(),
      project: dbToDto(project),
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get failed')
    return NextResponse.json({ error: 'Failed to load project' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = validate(ProjectIdParams, await params)
  if (!p.ok) return p.response
  const { id } = p.data
  const parsed = await parseBody(req, ProjectPatchSchema, { max: BODY_LIMITS.project })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  try {
    const existing = await db.project.findUnique({ where: { id }, select: { ownerToken: true } })
    if (!existing) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!canAccess(existing.ownerToken, (await getRequestOwner(req)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string') data.name = body.name
    if ('aoi' in body) data.aoi = toJson(body.aoi)
    if (typeof body.mapStyle === 'string') data.mapStyle = body.mapStyle

    // If the caller sends layers/messages, replace the whole set (simplest
    // correct semantics: a re-save snapshots current state). Done in a
    // transaction so a load never sees a half-updated project.
    const replaceLayers = Array.isArray(body.layers)
    const replaceMessages = Array.isArray(body.messages)

    await db.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.project.update({ where: { id }, data })
      } else {
        // Touch updatedAt even on a pure layer/message replace.
        await tx.project.update({ where: { id }, data: { updatedAt: new Date() } })
      }
      if (replaceLayers) {
        await tx.layer.deleteMany({ where: { projectId: id } })
        const layers = body.layers as ProjectDto['layers']
        if (layers.length > 0) {
          await tx.layer.createMany({
            data: layers.map((l, i) => ({ ...layerCreateData(l, i), projectId: id })),
          })
        }
      }
      if (replaceMessages) {
        await tx.message.deleteMany({ where: { projectId: id } })
        const messages = body.messages as ProjectDto['messages']
        if (messages.length > 0) {
          await tx.message.createMany({
            data: messages.map((m, i) => ({ ...messageCreateData(m, i), projectId: id })),
          })
        }
      }
    })

    const updated = await db.project.findUnique({ where: { id }, select: { updatedAt: true } })
    return NextResponse.json({ id, updatedAt: updated?.updatedAt.toISOString() })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'patch failed')
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = validate(ProjectIdParams, await params)
  if (!p.ok) return p.response
  const { id } = p.data
  try {
    const existing = await db.project.findUnique({ where: { id }, select: { ownerToken: true } })
    if (!existing) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!canAccess(existing.ownerToken, (await getRequestOwner(req)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'delete failed')
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 })
  }
}
