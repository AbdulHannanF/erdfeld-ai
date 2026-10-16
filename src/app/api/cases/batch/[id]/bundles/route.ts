/**
 * Q-28 — every case's signed evidence bundle of a batch in one zip. Each file is exactly what
 * GET /api/ledger/:runId/bundle returns for that case (same builder, same owner check).
 */

import JSZip from 'jszip'
import { NextRequest, NextResponse } from 'next/server'

import { signedBundleFor } from '../../../../evidence/bundle-service'
import { getLogger } from '../../../../agent/lib/logger'
import { openBatch } from '../access'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const log = getLogger('api/cases/batch/bundles')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const view = await openBatch(req, params)
    if (view instanceof Response) return view
    const zip = new JSZip()
    let n = 0
    for (const r of view.rows) {
      if (!r.run_id) continue
      const bundle = await signedBundleFor(req, r.run_id)
      if (bundle instanceof NextResponse) continue
      zip.file(`${String(r.idx + 1).padStart(3, '0')}-${r.run_id}.json`, JSON.stringify(bundle, null, 2))
      n++
    }
    if (n === 0) return NextResponse.json({ error: 'No case in this batch has a bundle yet' }, { status: 404 })
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    return new Response(Buffer.from(data), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="claims-${view.id}-bundles.zip"`, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'bundle zip failed')
    return NextResponse.json({ error: 'Failed to build the bundles' }, { status: 500 })
  }
}
