/**
 * Q-29 — verify an evidence bundle.
 *
 *   POST /api/evidence/verify  (body: the bundle) → `{ valid, signature, consistency, warnings }`
 *
 * Checks the detached signature against this server's published key and recomputes every
 * result_id from its inputs_hash and data items. A bundle signed by another key (or by an
 * ephemeral key from before a restart) is reported invalid with that reason, not guessed at.
 */

import { NextRequest, NextResponse } from 'next/server'

import { verifyBundle } from '@/lib/evidence-bundle'
import { getSigningKey } from '@/lib/evidence-key'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 8 * 1024 * 1024

export async function POST(req: NextRequest) {
  const text = await req.text()
  if (text.length > MAX_BYTES) return NextResponse.json({ error: 'Bundle too large' }, { status: 413 })
  let bundle: unknown
  try {
    bundle = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'The body is not JSON' }, { status: 400 })
  }
  try {
    return NextResponse.json(verifyBundle(bundle, getSigningKey().publicKeyPem))
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
