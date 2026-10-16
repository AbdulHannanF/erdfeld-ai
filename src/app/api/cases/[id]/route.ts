/**
 * Q-27 — one case: the claim, the verdict a recipe version reached, the evidence timeline and the
 * narration of the recorded evidence. Owner-scoped like projects and the ledger.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { CaseIdParams, validate } from '@/lib/api-schemas'
import { canAccessProject } from '@/lib/projects'

import { defaultCaseStore } from '../../agent/engine/claims/case-store'
import { defaultCatalog } from '../../agent/engine/claims/loader'
import { loadCaseView } from '../../agent/engine/claims/service'
import { defaultEvidenceStore } from '../../agent/engine/evidence-store'
import { getLogger } from '../../agent/lib/logger'

export const dynamic = 'force-dynamic'

const log = getLogger('api/cases')

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = validate(CaseIdParams, await params)
  if (!p.ok) return p.response
  try {
    const record = await (await defaultCaseStore()).get(p.data.id)
    if (!record) return NextResponse.json({ error: 'Case not found' }, { status: 404 })
    if (!canAccessProject(record.ownerToken, await getRequestOwner(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json(await loadCaseView({ catalog: defaultCatalog(), evidence: await defaultEvidenceStore() }, record))
  } catch (err) {
    log.error({ err: (err as Error)?.message }, 'get case failed')
    return NextResponse.json({ error: 'Failed to load the case' }, { status: 500 })
  }
}
