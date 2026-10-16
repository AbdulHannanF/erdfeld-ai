'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { apiErrorMessage } from '@/lib/api-errors'
import { getOwnerToken } from '@/lib/projects'
import { useJobs } from '@/store/useJobs'
import { useStore } from '@/store/useStore'

/** Run one registry operation over the drawn area, on the batch queue (`POST /api/jobs`). The queue
 *  runs it through the same executor an agent step uses, so the static and dynamic checks apply:
 *  a refused or failed run says why, on the Jobs tab. The JobRunner mounted in the shell follows
 *  the batch and draws the result on the map when it finishes. */
export function useRunOperation() {
  const [submitting, setSubmitting] = useState(false)

  const run = useCallback(async (op: string, args: Record<string, unknown>, label: string): Promise<string | null> => {
    const aoi = useStore.getState().aoi
    if (!aoi?.geometry) {
      toast.error('Draw an area first', { description: 'Every operation runs over the drawn area.' })
      return null
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
        // Two attempts: every operation is idempotent (its result is stored under a hash of its inputs, so a
        // re-run overwrites the same result), and a worker lost mid-run is retried instead of lost.
        body: JSON.stringify({ label, maxAttempts: 2, jobs: [{ op, args, aoi: aoi.geometry }] }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(apiErrorMessage(body, `HTTP ${res.status}`))
      useJobs.getState().track({ id: body.id as string, label, kind: 'tool', op })
      toast.success(`${label} queued`, { description: 'Follow it on the Jobs tab. The result is drawn on the map when it finishes.' })
      return body.id as string
    } catch (err) {
      toast.error(`${label} was not queued`, { description: err instanceof Error ? err.message : 'request failed' })
      return null
    } finally {
      setSubmitting(false)
    }
  }, [])

  return { run, submitting }
}
