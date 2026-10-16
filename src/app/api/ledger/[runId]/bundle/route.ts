/**
 * Q-29 — the signed evidence bundle of one ledger run.
 *
 *   GET /api/ledger/:runId/bundle → JSON `{ schema, schema_version, body, signature }`, the
 *   detached Ed25519 signature covering `canonicalJson(body)`. Owner-scoped like the ledger.
 *   Verify with `scripts/verify-bundle.mts` or POST /api/evidence/verify.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getLogger } from '../../../agent/lib/logger'
import { signedBundleFor } from '../../../evidence/bundle-service'

export const dynamic = 'force-dynamic'

const log = getLogger('api/ledger/bundle')

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  try {
    const out = await signedBundleFor(req, runId)
    if (out instanceof NextResponse) return out
    return new NextResponse(JSON.stringify(out, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="erdfeld-evidence-${runId}.json"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'bundle failed')
    return NextResponse.json({ error: 'Failed to build the evidence bundle' }, { status: 500 })
  }
}
