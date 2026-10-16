import { toast } from 'sonner'
import { getOwnerToken } from '@/lib/projects'
import type { LedgerExport, RerunNode } from '@/app/api/agent/engine/ledger'

/**
 * Client calls to the evidence-ledger endpoints. They are owner-scoped by the `x-owner-token`
 * header, so a plain link cannot reach them: each fetches, then hands the result to the browser.
 */

const headers = () => ({ 'x-owner-token': getOwnerToken() })

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** GET /api/ledger/:runId. Null when the run could not be read; the reason is in `error`. */
export async function fetchLedger(runId: string, signal?: AbortSignal): Promise<{ ledger: LedgerExport } | { error: string }> {
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(runId)}`, { headers: headers(), signal })
    if (res.status === 404) return { error: 'This run is not in the ledger, so only the figures held in this session are listed.' }
    if (res.status === 403) return { error: 'This run belongs to another owner.' }
    if (!res.ok) return { error: `The ledger could not be read (HTTP ${res.status}).` }
    return { ledger: (await res.json()) as LedgerExport }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return { error: 'cancelled' }
    return { error: 'The ledger could not be reached.' }
  }
}

/** GET /api/ledger/:runId/bundle: the Ed25519-signed evidence bundle, saved as a file. */
export async function downloadBundle(runId: string): Promise<void> {
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(runId)}/bundle`, { headers: headers() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    saveBlob(await res.blob(), `erdfeld-evidence-${runId}.json`)
    toast.success('Signed evidence bundle downloaded')
  } catch (e) {
    toast.error(`Could not download the evidence bundle: ${(e as Error).message}`)
  }
}

/** GET /api/ledger/:runId/summary: the one-page PDF, opened in a new tab. */
export async function openSummary(runId: string): Promise<void> {
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(runId)}/summary`, { headers: headers() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (e) {
    toast.error(`Could not open the PDF summary: ${(e as Error).message}`)
  }
}

export interface RerunReport {
  runId: string
  reproduced: boolean
  nodes: RerunNode[]
}

/** POST /api/ledger/:runId/rerun: run every node again and report which results reproduced. */
export async function rerunLedger(runId: string): Promise<RerunReport | { error: string }> {
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(runId)}/rerun`, { method: 'POST', headers: headers() })
    if (!res.ok) return { error: `The re-run could not be started (HTTP ${res.status}).` }
    return (await res.json()) as RerunReport
  } catch {
    return { error: 'The re-run could not be reached.' }
  }
}
