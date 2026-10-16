'use client'

import { Loader2, Upload } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiErrorMessage } from '@/lib/api-errors'
import { useJobs } from '@/store/useJobs'
import { MAX_BATCH_PLOTS, plotsFromFeatures, type PlotsFromFile } from '@/lib/batch-plots'
import { getOwnerToken } from '@/lib/projects'
import { IMPORT_ACCEPT, importVectorFile } from '@/lib/vector-io'
import { useStore } from '@/store/useStore'

interface ParamSpec { type: 'date' | 'number' | 'integer' | 'string'; description: string; required: boolean; default?: string | number; min?: number; max?: number }
interface ClaimType { ref: string; id: string; title: string; description: string; claim: string; params: Record<string, ParamSpec> }

export const OPEN_VERIFY_CLAIM = 'open-verify-claim'

/** "Verify a claim": a claim type, its parameters, and the plot. The plot is the drawn area (one
 *  case, run on the server in seconds to a minute, opening on its own page) or, for many plots, an
 *  uploaded file (GeoJSON, zipped Shapefile, KML, GPX, CSV; Q-28): one case per plot on the job
 *  queue, opening on the batch page. */
export default function VerifyClaimDialog() {
  const router = useRouter()
  const aoi = useStore((s) => s.aoi)
  const [open, setOpen] = useState(false)
  const [types, setTypes] = useState<ClaimType[]>([])
  const [typeId, setTypeId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'drawn' | 'file'>('drawn')
  const [file, setFile] = useState<{ name: string; crs: string; fc: GeoJSON.FeatureCollection; dropped: number } | null>(null)
  const [halfSide, setHalfSide] = useState('')

  useEffect(() => {
    const onOpen = () => { setError(null); setOpen(true) }
    window.addEventListener(OPEN_VERIFY_CLAIM, onOpen)
    return () => window.removeEventListener(OPEN_VERIFY_CLAIM, onOpen)
  }, [])

  useEffect(() => {
    if (!open || types.length) return
    fetch('/api/cases').then((r) => r.json()).then((b) => {
      setTypes(b.claim_types ?? [])
      setTypeId(b.claim_types?.[0]?.id ?? '')
    }).catch(() => setError('The claim types could not be loaded.'))
  }, [open, types.length])

  const type = types.find((t) => t.id === typeId)
  const geometry = aoi?.geometry
  const plotOk = geometry?.type === 'Polygon'

  const fromFile: PlotsFromFile | null = useMemo(
    () => (file && type ? plotsFromFeatures(file.fc, Object.keys(type.params), { halfSideM: Number(halfSide) || undefined }) : null),
    [file, type, halfSide],
  )

  const readFile = async (f: File | undefined) => {
    setError(null)
    setFile(null)
    if (!f) return
    try {
      const r = await importVectorFile(f.name, await f.arrayBuffer())
      setFile({ name: f.name, crs: r.crs, fc: r.fc, dropped: r.dropped.length })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The file could not be read.')
    }
  }

  const paramValues = () => {
    const params: Record<string, string | number> = {}
    for (const [name, spec] of Object.entries(type?.params ?? {})) {
      const v = values[`${type!.id}.${name}`]
      if (v === undefined || v === '') continue
      params[name] = spec.type === 'date' || spec.type === 'string' ? v : Number(v)
    }
    return params
  }

  const submitBatch = async () => {
    if (!type || !fromFile || fromFile.plots.length === 0 || fromFile.tooMany) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/cases/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
        body: JSON.stringify({ claim_type: type.ref, params: paramValues(), label: `${type.title}: ${file?.name}`, plots: fromFile.plots }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const named = (body?.issues ?? []).map((i: any) => {
          const k = /^plots\.(\d+)/.exec(i.path ?? '')
          return k ? `${fromFile.plots[Number(k[1])]?.name ?? `plot ${Number(k[1]) + 1}`}: ${i.message}` : i.message
        })
        throw new Error(named.length ? named.slice(0, 5).join('; ') : apiErrorMessage(body, `HTTP ${res.status}`))
      }
      useJobs.getState().track({ id: body.id as string, label: `${type.title}: ${file?.name}`, kind: 'claims', href: `/cases/batch/${body.id}` })
      router.push(`/cases/batch/${body.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The batch could not be queued.')
      setRunning(false)
    }
  }

  const submit = async () => {
    if (!type || !plotOk) return
    setRunning(true)
    setError(null)
    const params = paramValues()
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
        body: JSON.stringify({ claim_type: type.ref, params, geometry }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.issues?.map((i: any) => i.message).join('; ') || apiErrorMessage(body, `HTTP ${res.status}`))
      router.push(`/cases/${body.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The claim could not be checked.')
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !running && setOpen(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" data-testid="verify-claim-dialog">
        <DialogHeader>
          <DialogTitle>Verify a claim</DialogTitle>
          <DialogDescription>Checks a statement about the drawn area against satellite evidence. The answer can be Supported, Contradicted or Cannot determine.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div role="tablist" aria-label="Plots" className="segmented grid grid-cols-2">
            {([['drawn', 'The drawn area'], ['file', 'Many plots: upload a file']] as const).map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} data-testid={`verify-mode-${m}`} onClick={() => { setMode(m); setError(null) }}>{label}</button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-type">Claim</Label>
            <select id="claim-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} className="field">
              {types.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            {type && <p className="text-caption text-muted-foreground">{type.description}</p>}
          </div>
          {type && Object.entries(type.params).map(([name, spec]) => {
            const key = `${type.id}.${name}`
            return (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={key}>{name.replace(/_/g, ' ')}{spec.required ? '' : ' (optional)'}</Label>
                <Input
                  id={key}
                  type={spec.type === 'date' ? 'date' : spec.type === 'string' ? 'text' : 'number'}
                  min={spec.min} max={spec.max}
                  placeholder={spec.default !== undefined ? String(spec.default) : undefined}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                />
                {spec.description && <p className="text-caption text-muted-foreground">{spec.description}</p>}
              </div>
            )
          })}
          {mode === 'drawn' ? (
            <p className={`text-caption ${plotOk ? 'text-muted-foreground' : 'text-danger'}`}>
              {plotOk ? 'The plot is the area you drew.' : 'Draw a single polygon, rectangle or circle first: it is the plot the claim is about.'}
            </p>
          ) : (
            <div className="space-y-2" data-testid="verify-file">
              <Label htmlFor="batch-file">Plots file</Label>
              <label htmlFor="batch-file" className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 py-3 text-body text-muted-foreground hover:bg-secondary">
                <Upload className="h-4 w-4 shrink-0" aria-hidden />{file ? file.name : `GeoJSON, zipped Shapefile, KML, GPX or CSV (up to ${MAX_BATCH_PLOTS} plots)`}
              </label>
              <input id="batch-file" data-testid="batch-file" type="file" accept={IMPORT_ACCEPT} className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
              {fromFile && (
                <div className="space-y-1 text-caption text-muted-foreground" data-testid="batch-file-summary">
                  <p className={fromFile.plots.length && !fromFile.tooMany ? 'text-foreground' : 'text-danger'}>
                    {fromFile.tooMany ? `${fromFile.plots.length} plots: the limit is ${MAX_BATCH_PLOTS} per batch.` : `${fromFile.plots.length} plot${fromFile.plots.length === 1 ? '' : 's'} read (${file?.crs}).`}
                  </p>
                  {fromFile.skipped.length + (file?.dropped ?? 0) > 0 && (
                    <p>Skipped {fromFile.skipped.length + (file?.dropped ?? 0)}: {[...new Set(fromFile.skipped.map((s) => s.reason))].slice(0, 3).join('; ') || 'features the importer could not use'}.</p>
                  )}
                  {fromFile.paramColumns.length > 0 && <p>Per-plot values from the file: {fromFile.paramColumns.join(', ')} (they override the fields above).</p>}
                </div>
              )}
              {file && file.fc.features.some((f) => f.geometry?.type === 'Point') && (
                <div className="space-y-1.5">
                  <Label htmlFor="half-side">Points: half-side of the square plot (m)</Label>
                  <Input id="half-side" type="number" min={1} placeholder="e.g. 100 for a 200 m square" value={halfSide} onChange={(e) => setHalfSide(e.target.value)} data-testid="half-side" />
                </div>
              )}
            </div>
          )}
          {error && <p className="text-body text-danger" role="alert">{error}</p>}
          {running && mode === 'drawn' && <p className="text-caption text-muted-foreground">Reading satellite scenes. This usually takes 15 to 90 seconds.</p>}
        </div>
        <DialogFooter>
          {mode === 'drawn' ? (
            <Button onClick={submit} disabled={running || !plotOk || !type} data-testid="verify-claim-submit">
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check the claim
            </Button>
          ) : (
            <Button onClick={submitBatch} disabled={running || !type || !fromFile || fromFile.plots.length === 0 || fromFile.tooMany} data-testid="verify-batch-submit">
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check {fromFile?.plots.length ?? 0} plots
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
