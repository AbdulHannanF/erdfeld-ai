/** Shared by the batch routes: load a claim batch the caller may see, or the error response. */

import { NextRequest, NextResponse } from 'next/server'

import { getRequestOwner } from '@/lib/auth'
import { CaseIdParams, validate } from '@/lib/api-schemas'
import type { BatchView } from '@/lib/case-batch'
import { db } from '@/lib/db'
import { canAccessProject } from '@/lib/projects'

import { defaultCaseStore } from '../../../agent/engine/claims/case-store'
import { loadClaimBatch } from '../../../agent/engine/claims/batch'
import { defaultCatalog } from '../../../agent/engine/claims/loader'

export async function openBatch(req: NextRequest, rawParams: Promise<{ id: string }>): Promise<BatchView | Response> {
  const p = validate(CaseIdParams, await rawParams)
  if (!p.ok) return p.response
  const found = await loadClaimBatch(db, await defaultCaseStore(), defaultCatalog(), p.data.id)
  if (found.kind === 'not_found') return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  if (!canAccessProject(found.ownerToken, await getRequestOwner(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return found.view
}
