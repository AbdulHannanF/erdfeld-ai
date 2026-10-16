'use client'

import { useEffect, useMemo, useState } from 'react'
import { Info, Loader2, Play, Sparkles, TriangleAlert } from 'lucide-react'
import { Callout, WbDialog } from '@/components/shell/WbDialog'
import { BTN, BTN_PRIMARY, FIELD, OVERLINE } from '@/components/shell/ui'
import { useAgentWS } from '@/hooks/useAgentWS'
import { useRunOperation } from '@/hooks/useRunOperation'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { humanName, loadOperations, type OperationInfo, type SchemaProp } from '@/lib/operations-client'
import { chartDataNames, pickableResults } from '@/lib/pickable-results'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'

type Draft = Record<string, string | boolean>

function fieldKind(p: SchemaProp): 'select' | 'number' | 'boolean' | 'list' | 'text' {
  if (p.enum?.length) return 'select'
  if (p.type === 'number' || p.type === 'integer') return 'number'
  if (p.type === 'boolean') return 'boolean'
  if (p.type === 'array') return 'list'
  return 'text'
}

/** The arguments the form describes: only fields that were filled in, typed as the schema says. */
function buildArgs(op: OperationInfo, draft: Draft): { args: Record<string, unknown>; error?: string } {
  const args: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(op.params.properties)) {
    const raw = draft[name]
    if (raw === undefined || raw === '' || (p.type === 'boolean' && raw === false && !op.params.required.includes(name))) continue
    switch (fieldKind(p)) {
      case 'boolean':
        args[name] = raw === true
        break
      case 'number': {
        const n = Number(raw)
        if (!Number.isFinite(n)) return { args, error: `${name} must be a number` }
        args[name] = n
        break
      }
      case 'list': {
        const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean)
        if (p.items?.type === 'number') {
          const nums = parts.map(Number)
          if (nums.some((n) => !Number.isFinite(n))) return { args, error: `${name} must be numbers separated by commas` }
          args[name] = nums
        } else args[name] = parts
        break
      }
      default:
        args[name] = String(raw)
    }
  }
  const required = op.input_result && !op.params.required.includes('result_id') ? [...op.params.required, 'result_id'] : op.params.required
  const missing = required.filter((r) => args[r] === undefined)
  if (missing.length) return { args, error: `Fill in ${missing.join(', ')}` }
  return { args }
}

/** The tool dialog: what an operation does and where it is limited, its parameters from the
 *  registry's own schema, and the drawn area it will run over. Run queues it on the batch queue;
 *  Ask hands the same request to the assistant in words. */
export default function ToolDialog() {
  const dialog = useUi((s) => s.dialog)
  const toolName = useUi((s) => s.dialogTool)
  const closeDialog = useUi((s) => s.closeDialog)
  const setInspectorTab = useUi((s) => s.setInspectorTab)
  const setDockTab = useUi((s) => s.setDockTab)
  const aoi = useStore((s) => s.aoi)
  const toolResults = useStore((s) => s.toolResults)
  const mapLayers = useStore((s) => s.layers)
  const { run, submitting } = useRunOperation()
  const { sendQuery } = useAgentWS()
  const [ops, setOps] = useState<OperationInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [error, setError] = useState<string | null>(null)
  const open = dialog === 'tool' && !!toolName

  useEffect(() => {
    if (!open || ops) return
    loadOperations().then(setOps, (e: Error) => setLoadError(e.message))
  }, [open, ops])
  // A different tool starts from an empty form (adjusting state while rendering, not in an effect).
  const [draftTool, setDraftTool] = useState(toolName)
  if (draftTool !== toolName) {
    setDraftTool(toolName)
    setDraft({})
    setError(null)
  }

  const op = useMemo(() => ops?.find((o) => o.name === toolName), [ops, toolName])
  // An operation that works on an existing result is offered the results of this session to choose from.
  const pickable = useMemo(
    () => (op?.input_result ? pickableResults(toolResults, mapLayers, { vectorOnly: op.output === 'vector' }) : []),
    [op, toolResults, mapLayers],
  )
  const noInput = !!op?.input_result && pickable.length === 0
  const chosen = pickable.find((r) => r.resultId === draft.result_id)
  const km2 = aoiAreaKm2(aoi?.geometry)
  const tooBig = !!op && km2 != null && km2 > op.limits.maxAreaKm2
  const tooSmall = !!op && km2 != null && op.limits.minAreaKm2 != null && km2 < op.limits.minAreaKm2

  const submit = async () => {
    if (!op) return
    const built = buildArgs(op, draft)
    if (built.error) return setError(built.error)
    setError(null)
    const id = await run(op.name, built.args, humanName(op.name))
    if (id) {
      setDockTab('jobs')
      closeDialog()
    }
  }

  const ask = () => {
    if (!op) return
    const built = buildArgs(op, draft)
    if (built.error) return setError(built.error)
    const given = Object.entries(built.args).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')
    closeDialog()
    setInspectorTab('assistant')
    sendQuery(`Run ${op.name} over this area${given ? ` with ${given}` : ''}.`)
  }

  const props = op ? Object.entries(op.params.properties) : []

  return (
    <WbDialog
      open={open}
      onClose={closeDialog}
      kicker={op ? `PROCESSING TOOL · ${op.output.toUpperCase()} OUTPUT` : 'PROCESSING TOOL'}
      title={toolName ? humanName(toolName) : 'Tool'}
      description="Run a processing operation over the drawn area."
      testId="tool-dialog"
      foot={
        <>
          <button type="button" className={BTN} onClick={closeDialog}>Cancel</button>
          <button type="button" className={BTN} onClick={ask} disabled={!op || !aoi} title={aoi ? 'Have Erdfeld run it and explain the result' : 'Draw an area first'}>
            <Sparkles aria-hidden />Ask Erdfeld to run it
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={!op || !aoi || submitting || tooBig || tooSmall || noInput} data-testid="tool-run">
            {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}Run on area
          </button>
        </>
      }
    >
      {loadError && <Callout tone="bad" icon={<TriangleAlert />}>The operation registry could not be read: {loadError}</Callout>}
      {!op && !loadError && <p className="text-body text-muted-foreground" role="status">Reading the operation registry…</p>}
      {op && (
        <>
          <p className="text-body leading-relaxed text-muted-foreground">{op.description}</p>

          <div className="grid gap-1.5">
            <span className={OVERLINE}>Input</span>
            <div className="rounded-md border border-input bg-secondary px-2 py-1.5 text-body text-foreground" data-testid="tool-input">
              {aoi ? `Drawn area · ${aoi.type}${km2 != null ? ` · ${formatAreaKm2(km2)}` : ''}` : 'No area drawn'}
              {op.sensors.length > 0 && <span className="text-muted-foreground"> · reads {op.sensors.join(', ')}</span>}
            </div>
            {!aoi && <Callout tone="warn" icon={<TriangleAlert />}>Draw an area on the map first. Every operation runs over the drawn area.</Callout>}
            {tooBig && <Callout tone="warn" icon={<TriangleAlert />}>The area is {formatAreaKm2(km2!)}; this operation accepts at most {op.limits.maxAreaKm2.toLocaleString('en-US')} km². Draw a smaller one.</Callout>}
            {tooSmall && <Callout tone="warn" icon={<TriangleAlert />}>The area is {formatAreaKm2(km2!)}; this operation needs at least {op.limits.minAreaKm2} km².</Callout>}
            {noInput && (
              <Callout tone="warn" icon={<TriangleAlert />} >
                <span data-testid="tool-no-input">
                  {humanName(op.name)} works on an existing result ({op.input_result!.description.toLowerCase().replace(/\.$/, '')}), and this session has none{op.output === 'vector' ? ' with a vector layer' : ''}. Run another tool first, then come back.
                </span>
              </Callout>
            )}
          </div>

          {props.length > 0 && (
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-3 max-sm:grid-cols-1">
              {props.map(([name, p]) => {
                const kind = fieldKind(p)
                const picker = name === 'result_id' && !!op.input_result
                const required = op.params.required.includes(name) || picker
                const id = `tool-f-${name}`
                return (
                  <div key={name} className={kind === 'boolean' ? 'flex items-start gap-2' : p.description && p.description.length > 70 ? 'col-span-2 max-sm:col-span-1' : ''}>
                    {kind === 'boolean' ? (
                      <input id={id} type="checkbox" checked={draft[name] === true} onChange={(e) => setDraft({ ...draft, [name]: e.target.checked })} className="mt-1 size-4 accent-[var(--teal)]" />
                    ) : null}
                    <div className="grid min-w-0 flex-1 gap-1">
                      <label htmlFor={id} className={OVERLINE}>
                        {name.replace(/_/g, ' ')}{required && <span className="text-warning"> · required</span>}
                      </label>
                      {picker ? (
                        <select id={id} className={FIELD} value={String(draft[name] ?? '')} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} disabled={noInput} data-testid="tool-result-picker">
                          <option value="">{noInput ? 'No results yet' : 'Choose a result…'}</option>
                          {pickable.map((r) => <option key={r.resultId} value={r.resultId}>{r.label} ({r.resultId})</option>)}
                        </select>
                      ) : kind === 'select' ? (
                        <select id={id} className={FIELD} value={String(draft[name] ?? '')} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}>
                          <option value="">Default</option>
                          {p.enum!.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : kind === 'boolean' ? null : (
                        <input
                          id={id}
                          className={FIELD}
                          type={kind === 'number' ? 'number' : 'text'}
                          inputMode={kind === 'number' ? 'decimal' : undefined}
                          min={p.minimum}
                          max={p.maximum}
                          value={String(draft[name] ?? '')}
                          placeholder={kind === 'list' ? 'comma separated' : 'Default'}
                          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
                        />
                      )}
                      {p.description && <span className="text-caption leading-snug text-muted-foreground">{p.description}</span>}
                      {picker && chosen && op.name === 'make_chart' && (
                        <span className="break-all text-data leading-snug text-muted-foreground" data-testid="tool-data-names">Data names for the spec: {chartDataNames(chosen).join(', ')}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {error && <Callout tone="bad" icon={<TriangleAlert />}>{error}</Callout>}

          <Callout icon={<Info />}>
            <p>
              Typically about {op.cost.typicalSeconds} s. {op.limits.needsDates && 'Needs a date or period. '}
              {op.limits.earliest && `Data from ${op.limits.earliest}. `}
              {op.resolution_m != null && `About ${op.resolution_m} m resolution. `}
              Confidence: {op.confidence}
            </p>
            {op.limitations.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-foreground">Limits ({op.limitations.length})</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4">{op.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </details>
            )}
          </Callout>
        </>
      )}
    </WbDialog>
  )
}
