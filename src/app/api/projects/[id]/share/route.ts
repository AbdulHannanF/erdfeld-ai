/**
 * P6.2 — Mint a read-only share link for a project.
 *
 *   POST /api/projects/:id/share  → { token, url } for /share/:token
 *
 * Owner-token enforced (same rule as the rest of `/api/projects`): only the
 * project's owner (or anyone, for a legacy null-token project) may mint a link.
 * The minted token is public-read — resolving it (`GET /api/share/:token`)
 * needs no auth, which is the whole point of sharing.
 */

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { canAccessProject, generateShareToken } from '@/lib/projects'
import { getRequestOwner } from '@/lib/auth'
import { ProjectIdParams, validate } from '@/lib/api-schemas'
import { getLogger } from '../../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/projects/[id]/share')
const MAX_MINT_ATTEMPTS = 5

/** Crypto-backed unbiased integer in [0, max). */
function cryptoRandomInt(max: number): number {
  const buf = new Uint32Array(1)
  // Rejection sampling to avoid modulo bias.
  const limit = Math.floor(0xffffffff / max) * max
  let v: number
  do {
    crypto.getRandomValues(buf)
    v = buf[0]
  } while (v >= limit)
  return v % max
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = validate(ProjectIdParams, await params)
  if (!p.ok) return p.response
  const { id } = p.data

  try {
    const project = await db.project.findUnique({ where: { id }, select: { ownerToken: true } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!canAccessProject(project.ownerToken, await getRequestOwner(req))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Mint a unique token, retrying on the (very unlikely) PK collision.
    let token = ''
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const candidate = generateShareToken(8, cryptoRandomInt)
      const clash = await db.shareLink.findUnique({ where: { token: candidate }, select: { token: true } })
      if (!clash) {
        token = candidate
        break
      }
    }
    if (!token) {
      return NextResponse.json({ error: 'Could not mint a unique share token' }, { status: 500 })
    }

    await db.shareLink.create({ data: { token, projectId: id } })

    const origin = req.nextUrl.origin
    return NextResponse.json({ token, url: `${origin}/share/${token}` }, { status: 201 })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'mint failed')
    return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 })
  }
}
