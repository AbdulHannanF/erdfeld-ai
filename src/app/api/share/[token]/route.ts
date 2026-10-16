/**
 * P6.2 — Resolve a read-only share token.
 *
 *   GET /api/share/:token  → { token, projectId, name, createdAt, updatedAt,
 *                              sharedAt, viewCount, project: ProjectDto }
 *
 * No auth: the token itself is the (read-only) capability. Bumps `viewCount`.
 * The returned snapshot is frozen — provenance/confidence are copied verbatim
 * (see `dbToDto`), so a viewer never sees recomputed numbers.
 */

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { type SharedProjectDto } from '@/lib/projects'
import { ShareTokenParams, validate } from '@/lib/api-schemas'
import { getLogger } from '../../agent/lib/logger'
import { dbToDto } from '../../projects/serialize'

export const dynamic = 'force-dynamic'

const log = getLogger('api/share/[token]')

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const p = validate(ShareTokenParams, await params)
  if (!p.ok) return p.response
  const { token } = p.data

  try {
    const link = await db.shareLink.findUnique({ where: { token } })
    if (!link) return NextResponse.json({ error: 'Share link not found' }, { status: 404 })

    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: 'Share link expired' }, { status: 410 })
    }

    const project = await db.project.findUnique({
      where: { id: link.projectId },
      include: { layers: true, messages: true },
    })
    if (!project) {
      // Project was deleted (cascade should have removed the link too, but be safe).
      return NextResponse.json({ error: 'Shared project no longer exists' }, { status: 404 })
    }

    // Best-effort view count bump (don't fail the read if it errors).
    db.shareLink
      .update({ where: { token }, data: { viewCount: { increment: 1 } } })
      .catch((e) => log.warn({ err: (e as Error)?.message }, 'viewCount bump failed'))

    const payload: SharedProjectDto = {
      token,
      projectId: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      sharedAt: link.createdAt.toISOString(),
      viewCount: link.viewCount + 1,
      project: dbToDto(project),
    }
    return NextResponse.json(payload)
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'resolve failed')
    return NextResponse.json({ error: 'Failed to load shared project' }, { status: 500 })
  }
}
