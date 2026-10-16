'use client'

import { BrandMark } from '@/components/shell/BrandMark'
import { ArrowLeft, Download, Loader2 } from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { FigureGrid, ResultIdChip } from '@/components/evidence/EvidencePieces'
import { ABSTAIN_LABEL, VERDICT_CLASS, VERDICT_LABEL, type CaseViewData } from '@/lib/case-view'
import { getOwnerToken } from '@/lib/projects'

const CaseMap = dynamic(() => import('@/components/evidence/CaseMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-card" />,
})

interface EvidenceLayer { key: string; label: string; step: number; layer: any }

const short = (id: string) => id.slice(0, 10)

/** Fetch the layers each node of the case recorded, through the owner-scoped results route.
 *  A node whose result cannot be read simply contributes no layer. */
async function loadLayers(view: CaseViewData): Promise<EvidenceLayer[]> {
  const out: EvidenceLayer[] = []
  await Promise.all(view.timeline.filter((t) => t.result_id).map(async (t) => {
    try {
      const res = await fetch(`/api/results/${t.result_id}`, { headers: { 'x-owner-token': getOwnerToken() } })
      if (!res.ok) return
      const { result } = await res.json()
      for (const layer of result.layers ?? []) {
        out.push({ key: `${t.result_id}:${layer.id}`, label: layer.name ?? layer.id, step: t.step, layer })
      }
    } catch { /* no layer for this node */ }
  }))
  return out.sort((a, b) => a.step - b.step || a.label.localeCompare(b.label))
}

export default function CaseView({ id }: { id: string }) {
  const [view, setView] = useState<CaseViewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layers, setLayers] = useState<EvidenceLayer[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`/api/cases/${encodeURIComponent(id)}`, { headers: { 'x-owner-token': getOwnerToken() } })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(res.status === 403 ? 'This case belongs to another owner.' : res.status === 404 ? 'No such case.' : body?.error ?? `HTTP ${res.status}`)
        }
        const v = (await res.json()) as CaseViewData
        if (!live) return
        setView(v)
        const ev = await loadLayers(v)
        if (live) {
          setLayers(ev)
          // Radar scenes of the reference date and the like start hidden unless they are the first of their kind.
          setHidden(new Set(ev.filter((l) => l.layer.defaultVisible === false).map((l) => l.key)))
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'The case could not be loaded.')
      }
    })()
    return () => { live = false }
  }, [id])

  const mapLayers = useMemo(() => layers.map((l) => ({
    id: l.key, visible: !hidden.has(l.key), tileUrl: l.layer.tileUrl, imageBase64: l.layer.imageBase64, geojson: l.layer.geojson, bounds: l.layer.bounds,
  })), [layers, hidden])

  const download = async () => {
    if (!view?.bundle_url) return
    const res = await fetch(view.bundle_url, { headers: { 'x-owner-token': getOwnerToken() } })
    if (!res.ok) { setError('The evidence bundle could not be built.'); return }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = `erdfeld-evidence-${view.run_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const shell = (children: React.ReactNode) => (
    <div className="h-screen overflow-y-auto bg-background text-foreground" data-testid="case-page">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-brand-text hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to the map</Link>
        <BrandMark height={32} className="ml-auto" />
      </header>
      {children}
    </div>
  )

  if (error) return shell(<p className="mx-auto max-w-2xl p-6 text-destructive" role="alert" data-testid="case-error">{error}</p>)
  if (!view) return shell(<p className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the case...</p>)

  const confidence = view.confidence != null ? `${Math.round(view.confidence * 100)}%` : null

  return shell(
    <main className="mx-auto grid max-w-[93.75rem] gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-6">
      <aside className="min-w-0 lg:order-2">
        <div className="lg:sticky lg:top-20 space-y-3">
          <div className="h-[18.75rem] lg:h-[calc(100vh-14rem)] lg:min-h-[22.5rem] overflow-hidden rounded-lg border border-border"><CaseMap geometry={view.geometry} layers={mapLayers} /></div>
          {layers.length > 0 && (
            <fieldset className="min-w-0 rounded-lg border border-border bg-card p-3">
              <legend className="px-1 text-xs text-muted-foreground">Evidence layers</legend>
              <ul className="space-y-1.5 text-sm">
                {layers.map((l) => (
                  <li key={l.key}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" className="accent-brand-500" checked={!hidden.has(l.key)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(l.key)) n.delete(l.key); else n.add(l.key); return n })} />
                      <span className="min-w-0 truncate">{l.label}</span><span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">step {l.step}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>
      </aside>
      <div className="min-w-0 space-y-6 lg:order-1">
        <section aria-labelledby="case-claim">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Claim</p>
          <h1 id="case-claim" className="mt-1 font-heading text-2xl font-medium leading-snug">{view.claim}</h1>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span data-testid="verdict-badge" className={`inline-flex items-center rounded-md border px-3 py-1.5 font-heading text-lg font-medium ${VERDICT_CLASS[view.verdict]}`}>
              {VERDICT_LABEL[view.verdict]}
            </span>
            {confidence && (
              <span data-testid="confidence" className="text-sm text-muted-foreground" title="A stated heuristic score from the recipe, not a probability; the evaluation reports how well it is calibrated.">
                confidence <strong className="tabular-nums text-foreground">{confidence}</strong>
              </span>
            )}
            {view.verdict === 'cannot_determine' && view.decision.kind && (
              <span className="text-sm text-aqua-text">{ABSTAIN_LABEL[view.decision.kind] ?? view.decision.kind}</span>
            )}
          </div>
          <p className="mt-3 text-sm leading-relaxed">{view.decision.reason}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Recipe <code>{view.recipe}</code> · rule <code>{view.decision.rule}</code> · {new Date(view.created_at).toISOString().slice(0, 10)}
            {view.run_id && <> · ledger run <code>{short(view.run_id)}</code></>}
          </p>
          {view.bundle_url && (
            <button onClick={download} data-testid="download-bundle" className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Download className="h-4 w-4" aria-hidden /> Download signed evidence bundle
            </button>
          )}
        </section>

        <section aria-labelledby="case-timeline">
          <h2 id="case-timeline" className="font-heading text-lg font-medium">Evidence timeline</h2>
          <ol className="mt-3 space-y-3" data-testid="timeline">
            {view.timeline.map((t) => (
              <li key={t.step} className="rounded-lg border border-border bg-card p-3" data-testid="timeline-node">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xs text-muted-foreground tabular-nums">Step {t.step}</span>
                  <span className="font-medium">{t.op}<span className="text-muted-foreground">@{t.version}</span></span>
                  {t.date && <span className="text-sm tabular-nums text-aqua-text">{t.date}</span>}
                  <span className={`text-xs ${t.status === 'ok' ? 'text-leaf-text' : 'text-destructive'}`}>{t.status}</span>
                  {t.result_id && <span className="ml-auto min-w-0"><ResultIdChip id={t.result_id} /></span>}
                </div>
                {Object.keys(t.stats).length > 0 ? (
                  <FigureGrid className="mt-2" entries={Object.entries(t.stats).slice(0, 9).map(([k, v]) => [k, String(v)])} />
                ) : t.summary ? <p className="mt-2 text-xs text-muted-foreground">{t.summary}</p> : null}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="case-explain">
          <h2 id="case-explain" className="font-heading text-lg font-medium">Explain</h2>
          <p className="mt-1 text-xs text-muted-foreground">Built from the recorded results and the recipe only; no model wrote it. Each sentence names the result it rests on.</p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed" data-testid="explain">
            {view.explain.map((l, i) => (
              <li key={i}>
                {l.text}
                {l.cites.length > 0 && <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">{[...new Set(l.cites)].map((c) => <code key={c} className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">{c}</code>)}</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>

    </main>,
  )
}
