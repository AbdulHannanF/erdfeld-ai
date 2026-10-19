'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Database, History, Layers, Settings, Sparkles, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import AnswerView from '@/components/answer/AnswerView'
import Composer from '@/components/composer/Composer'
import InvestigationBoard from '@/components/investigate/InvestigationBoard'
import { DockBody, DockTabs } from '@/components/shell/Dock'
import LayersTab from '@/components/shell/LayersTab'
import { Segmented } from '@/components/shell/Segmented'
import ToolboxPanel from '@/components/shell/ToolboxPanel'
import Welcome from '@/components/shell/Welcome'
import { ICON_BTN } from '@/components/shell/ui'
import { useAgentWS } from '@/hooks/useAgentWS'
import { useStore } from '@/store/useStore'
import { useUi, type InspectorTab, type PanelMode } from '@/store/useUi'
import { sampleCaseToAOI, serverCanAnswer, type SampleCase } from '@/lib/sample-cases'
import { cn } from '@/lib/utils'

const TABS: Array<{ id: InspectorTab; label: string; icon: typeof Layers; mobileOnly?: boolean }> = [
  { id: 'tools', label: 'Tools', icon: SlidersHorizontal },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'assistant', label: 'Erdfeld', icon: Sparkles },
  { id: 'data', label: 'Data', icon: Database, mobileOnly: true },
]

/**
 * The right-hand inspector, 360px wide: Tools (the processing toolbox), Layers, and Erdfeld (the
 * assistant: Ask or Investigate), with the question box beneath. On a phone the same content is a
 * bottom sheet that snaps between peek, half and full height, with a fourth tab for the data dock.
 */
export default function Inspector({ sheet = false }: { sheet?: boolean }) {
  const tab = useUi((s) => s.inspectorTab)
  const setTab = useUi((s) => s.setInspectorTab)
  const mode = useUi((s) => s.panelMode)
  const setMode = useUi((s) => s.setPanelMode)
  const snap = useUi((s) => s.sheetSnap)
  const setSnap = useUi((s) => s.setSheetSnap)
  const openDialog = useUi((s) => s.openDialog)
  const hasConversation = useStore((s) => s.messages.length > 0)
  const isLoading = useStore((s) => s.isLoading)
  const lastQuery = useStore((s) => s.lastQuery)
  const aoi = useStore((s) => s.aoi)
  const layerCount = useStore((s) => s.layers.length)
  const settings = useStore((s) => s.settings)
  const setAoi = useStore((s) => s.setAoi)
  const setFitBoundsTarget = useStore((s) => s.setFitBoundsTarget)
  const setSettingsPanelOpen = useStore((s) => s.setSettingsPanelOpen)
  const setAgentError = useStore((s) => s.setAgentError)
  const { sendQuery, cancelAnalysis } = useAgentWS()
  const [input, setInput] = useState('')
  const thread = useRef<HTMLDivElement>(null)

  // Follow the answer as it streams in, unless the person has scrolled up to read.
  useEffect(() => {
    const el = thread.current
    if (!el || tab !== 'assistant') return
    let prev = ''
    return useStore.subscribe((state) => {
      if (state.streamingContent === prev) return
      prev = state.streamingContent
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
    })
  }, [tab])

  const send = useCallback(
    (q: string) => {
      setInput('')
      setTab('assistant')
      setMode('ask')
      if (sheet && useUi.getState().sheetSnap === 'peek') setSnap('half')
      sendQuery(q)
    },
    [sendQuery, setTab, setMode, setSnap, sheet],
  )

  const retry = useCallback(() => {
    const q = lastQuery?.trim()
    if (!q || !aoi) return
    setAgentError(null)
    sendQuery(q)
  }, [lastQuery, aoi, sendQuery, setAgentError])

  // A sample case sets its area, fits the map to it and asks its question. "Default (built-in)"
  // runs on the server's own key when it has one; only with no provider at all is the question
  // pre-filled and Settings opened instead.
  const pickSample = useCallback(
    async (c: SampleCase) => {
      setAoi(sampleCaseToAOI(c))
      setFitBoundsTarget(c.bbox)
      if (settings.aiProvider !== 'default' || (await serverCanAnswer())) {
        window.setTimeout(() => send(c.question), 900)
      } else {
        setInput(c.question)
        setSettingsPanelOpen(true)
        toast.info('Area ready. Choose an AI provider', { description: 'Pick a provider in Settings, then press Ask Erdfeld to run this case.' })
      }
    },
    [settings.aiProvider, send, setAoi, setFitBoundsTarget, setSettingsPanelOpen],
  )

  const peek = sheet && snap === 'peek'
  const tabs = TABS.filter((t) => sheet || !t.mobileOnly)
  const showComposer = tab !== 'data' && !(tab === 'assistant' && mode === 'investigate') && (!sheet || tab === 'assistant')

  return (
    <aside
      aria-label="Inspector: processing toolbox, layers and Erdfeld"
      data-testid="panel"
      data-snap={sheet ? snap : undefined}
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-card',
        sheet
          ? 'fixed inset-x-0 bottom-0 z-30 rounded-t-[0.875rem] border-t border-border shadow-float transition-[height] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]'
          : 'row-span-2 [grid-column:2]',
      )}
      style={sheet ? { height: snap === 'peek' ? 76 : snap === 'half' ? '52dvh' : '88dvh' } : undefined}
    >
      {sheet && (
        <button
          type="button"
          onClick={() => setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek')}
          className="flex h-[4.75rem] w-full shrink-0 flex-col items-center justify-start gap-1.5 px-4 pt-2 text-left data-[open=true]:h-8"
          data-open={!peek}
          aria-label={peek ? 'Open the panel' : snap === 'half' ? 'Expand the panel' : 'Collapse the panel'}
          data-testid="sheet-handle"
        >
          <span className="h-1 w-9 rounded-full bg-input" aria-hidden />
          {peek && (
            <span className="flex w-full items-center justify-between gap-3 text-body text-foreground">
              <span className="min-w-0 truncate">{isLoading ? 'Working on it' : lastQuery || 'Ask Erdfeld about this area'}</span>
              <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </span>
          )}
          {!peek && snap === 'full' && <ChevronDown className="sr-only" aria-hidden />}
        </button>
      )}

      <div className={cn('flex min-h-0 flex-1 flex-col', peek && 'hidden')}>
        <header className="flex h-[2.875rem] shrink-0 items-center justify-between border-b border-border px-2.5">
          <div role="tablist" aria-label="Inspector panels" className="flex h-full min-w-0 items-stretch gap-0.5">
            {tabs.map((t) => {
              const Icon = t.icon
              const selected = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`inspector-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls="inspector-body"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => {
                    const i = tabs.findIndex((x) => x.id === t.id)
                    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null
                    if (next) {
                      e.preventDefault()
                      setTab(next.id)
                      document.getElementById(`inspector-tab-${next.id}`)?.focus()
                    }
                  }}
                  className="tab"
                >
                  <Icon className="size-3.5 max-[380px]:hidden" aria-hidden />
                  {t.label}
                  {t.id === 'layers' && layerCount > 0 && <span className="badge">{layerCount}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex shrink-0 gap-0.5">
            <button type="button" className={ICON_BTN} onClick={() => openDialog('activity')} aria-label="Activity history" title="Activity history">
              <History aria-hidden />
            </button>
            <button type="button" className={ICON_BTN} onClick={() => setSettingsPanelOpen(true)} aria-label="Settings and AI provider" title="Settings and AI provider">
              <Settings aria-hidden />
            </button>
          </div>
        </header>

        <div
          ref={thread}
          id="inspector-body"
          role="tabpanel"
          aria-labelledby={`inspector-tab-${tab}`}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3"
        >
          {tab === 'tools' && <ToolboxPanel />}
          {tab === 'layers' && <LayersTab />}
          {tab === 'data' && (
            <div className="-mx-3 -mt-3 flex min-h-full flex-col">
              <DockTabs compact />
              <DockBody />
            </div>
          )}
          {tab === 'assistant' && (
            <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-md border border-border bg-accent text-accent-foreground"><Sparkles className="size-3.5" aria-hidden /></span>
                  <div>
                    <h2 className="font-heading text-body-strong leading-none text-foreground">Erdfeld</h2>
                    <p className="mt-1 text-label text-muted-foreground" aria-live="polite">{isLoading ? 'Working' : 'Ready'}</p>
                  </div>
                </div>
                <Segmented<PanelMode>
                  label="Assistant mode"
                  size="sm"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'ask', label: 'Ask' },
                    { value: 'investigate', label: 'Investigate' },
                  ]}
                />
              </div>
              {mode === 'investigate' ? <InvestigationBoard /> : hasConversation ? <AnswerView onRetry={retry} /> : <Welcome onPickSample={pickSample} />}
            </div>
          )}
        </div>

        {showComposer && <Composer value={input} onChange={setInput} onSend={send} onCancel={cancelAnalysis} />}
      </div>
    </aside>
  )
}
