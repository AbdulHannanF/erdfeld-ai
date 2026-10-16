'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ExternalLink, FileCheck2, ListChecks, ShieldCheck } from 'lucide-react'
import { ExportList } from '@/components/answer/ExportMenu'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN } from '@/components/shell/ui'
import { useUi } from '@/store/useUi'
import { useJobs } from '@/store/useJobs'
import { useStore } from '@/store/useStore'

/** Layouts and reports: the evidence exports the app produces from a run (signed bundle, PDF
 *  summary, reproducible JSON, Markdown), the claim batches and cases that have their own report
 *  pages, and how to verify a bundle. Nothing here is a template: each action works on the run. */
export default function ReportsDialog() {
  const open = useUi((s) => s.dialog) === 'reports'
  const closeDialog = useUi((s) => s.closeDialog)
  const openDialog = useUi((s) => s.openDialog)
  const allBatches = useJobs((s) => s.batches)
  const batches = useMemo(() => allBatches.filter((b) => b.kind === 'claims'), [allBatches])
  const latestRun = useStore((s) => s.ledgerRunIds[s.ledgerRunIds.length - 1])

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      testId="reports-dialog"
      kicker="LAYOUTS & REPORTS"
      title="Reports and evidence"
      description="Export a run as a signed bundle, a PDF summary, or a data file, and open claim reports."
      foot={<button type="button" className={BTN} onClick={closeDialog}>Close</button>}
    >
      <div className="rounded-md border border-border bg-sunk p-1.5">
        <ExportList />
      </div>

      <div className="grid gap-1.5">
        <p className="font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Claim reports</p>
        {batches.length === 0 ? (
          <Callout icon={<ListChecks />}>
            A claim batch or a single claim check has its own report page, with the verdict, the timeline of results and a signed bundle. Start one with &ldquo;Verify a claim&rdquo; in the Tools panel.
          </Callout>
        ) : (
          <ul className="grid gap-1">
            {batches.map((b) => (
              <li key={b.id}>
                <Link href={b.href ?? `/cases/batch/${b.id}`} className="flex items-center justify-between gap-2 rounded-md border border-border bg-sunk px-2.5 py-2 text-[0.8125rem] text-foreground hover:bg-hover">
                  <span className="truncate">{b.label}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={BTN} onClick={() => { closeDialog(); openDialog('activity') }}>
          <FileCheck2 className="size-3.5" aria-hidden />Open Activity history
        </button>
      </div>

      <Callout icon={<ShieldCheck />}>
        {latestRun
          ? 'The signed bundle restates every result of the latest run with its content-hash id. Anyone can check the signature against the public key at /api/evidence/public-key.'
          : 'The signed bundle and PDF summary appear once a question has run and its ledger is saved.'}
      </Callout>
    </WbDialog>
  )
}
