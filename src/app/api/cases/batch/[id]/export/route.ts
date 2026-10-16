/**
 * Q-28 — the verdict table of a batch as a file: CSV (plot centroids), GeoJSON, KML or Shapefile,
 * through the same exporters as every other layer. One row per plot with the verdict,
 * confidence, abstention kind, recipe@version, case id, ledger run id and the result ids it rests on.
 */

import { NextRequest, NextResponse } from 'next/server'

import { BatchExportQuery, validate } from '@/lib/api-schemas'
import { exportVector } from '@/lib/vector-io'

import { batchFeatures } from '../../../../agent/engine/claims/batch'
import { defaultEvidenceStore } from '../../../../agent/engine/evidence-store'
import { getLogger } from '../../../../agent/lib/logger'
import { openBatch } from '../access'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const log = getLogger('api/cases/batch/export')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const q = validate(BatchExportQuery, Object.fromEntries(req.nextUrl.searchParams))
  if (!q.ok) return q.response
  try {
    const view = await openBatch(req, params)
    if (view instanceof Response) return view
    const evidence = await defaultEvidenceStore()
    const resultIds = new Map<string, string[]>()
    const runs = [...new Set(view.rows.flatMap((r) => (r.run_id ? [r.run_id] : [])))]
    for (let i = 0; i < runs.length; i += 25) {
      await Promise.all(runs.slice(i, i + 25).map(async (id) => {
        const run = await evidence.getRun(id)
        resultIds.set(id, run?.nodes.flatMap((n) => (n.resultId ? [n.resultId] : [])) ?? [])
      }))
    }
    const out = await exportVector(batchFeatures(view.rows, resultIds), q.data.format, `claims-${view.id}`)
    return new Response(typeof out.data === 'string' ? out.data : Buffer.from(out.data), {
      headers: { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'export batch failed')
    return NextResponse.json({ error: 'Failed to export the batch' }, { status: 500 })
  }
}
