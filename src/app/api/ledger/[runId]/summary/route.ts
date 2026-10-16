/**
 * Q-29 — one-page PDF summary of the signed evidence bundle of a run.
 *
 *   GET /api/ledger/:runId/summary → application/pdf. Owner-scoped. The JSON bundle
 *   (/api/ledger/:runId/bundle) is the signed record; the PDF restates it.
 */

import { NextRequest, NextResponse } from 'next/server'

import { bundleSummaryPdf } from '@/lib/evidence-pdf'
import { getLogger } from '../../../agent/lib/logger'
import { signedBundleFor } from '../../../evidence/bundle-service'

export const dynamic = 'force-dynamic'

const log = getLogger('api/ledger/summary')

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  try {
    const out = await signedBundleFor(req, runId)
    if (out instanceof NextResponse) return out
    return new NextResponse(Buffer.from(await bundleSummaryPdf(out)), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="erdfeld-evidence-${runId}.pdf"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'summary failed')
    return NextResponse.json({ error: 'Failed to build the evidence summary' }, { status: 500 })
  }
}
