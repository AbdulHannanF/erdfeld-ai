'use client'

import { useCallback, useEffect, useRef } from 'react'
import { Check, Lightbulb, Mic, Paperclip, Send, Square, TriangleAlert, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { SAMPLE_CASES } from '@/lib/sample-cases'
import { cn } from '@/lib/utils'

const MAX_LENGTH = 4000

/** Questions worth asking about any area, then the cases that were run end to end. Picking one
 *  fills the question box; nothing is sent until the person sends it. */
const IDEAS = [
  'How does the land cover and vegetation vary across this area?',
  'Analyze the terrain here: elevation range, slope and aspect. Where is it steepest?',
  'Has this area changed over the last two years? Show where and by how much.',
  ...SAMPLE_CASES.map((c) => c.question),
]

const tool = 'btn btn-ghost btn-sm'

/** The question box as the workbench draws it: which area it will ask about, the text, Add data and
 *  Prompt ideas, dictation, and Ask Erdfeld. The area itself is drawn on the map; this only states
 *  which one is in effect. */
export default function Composer({
  value,
  onChange,
  onSend,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onSend: (q: string) => void
  onCancel: () => void
}) {
  const aoi = useStore((s) => s.aoi)
  const isLoading = useStore((s) => s.isLoading)
  const pointFocus = useStore((s) => s.pointFocus)
  const setPointFocus = useStore((s) => s.setPointFocus)
  const openDialog = useUi((s) => s.openDialog)
  const ref = useRef<HTMLTextAreaElement>(null)
  const voice = useVoiceInput(value, onChange)

  const km2 = aoiAreaKm2(aoi?.geometry)
  const canSend = value.trim().length > 0 && !!aoi && !isLoading

  // Grow with the text, up to about five lines.
  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])
  useEffect(fit, [value, fit])

  const send = () => {
    if (!canSend) return
    onSend(value.trim())
  }

  return (
    <div className="border-t border-border bg-card px-3.5 pb-3 pt-2.5 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-testid="composer">
      <p
        className={cn('mx-0.5 mb-[0.4375rem] flex items-center gap-1.5 text-body', aoi ? 'text-muted-foreground' : 'text-warning')}
        data-testid="composer-aoi"
      >
        {aoi ? <Check className="size-3.5 shrink-0 text-success" aria-hidden /> : <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate" role="status">
          {aoi ? `${aoi.type} area${km2 != null ? ` · ${formatAreaKm2(km2)}` : ''} selected · ready to ask` : 'Draw an area before asking'}
        </span>
        <span className="ml-auto" />
        {pointFocus && (
          <span className="chip min-w-0 bg-accent text-accent-foreground">
            <span className="truncate tabular-nums">Point {pointFocus.lat.toFixed(3)}, {pointFocus.lng.toFixed(3)}</span>
            <button type="button" onClick={() => setPointFocus(null)} aria-label="Clear the picked point" className="link-btn">
              <X aria-hidden />
            </button>
          </span>
        )}
      <button
        type="button"
        onClick={voice.toggle}
        aria-pressed={voice.recording}
        aria-label={voice.recording ? 'Stop voice input' : 'Dictate the question (Ctrl+M)'}
        title={voice.recording ? 'Stop voice input' : 'Dictate the question (Ctrl+M)'}
        className={cn('btn btn-icon-sm ml-1', voice.recording ? 'btn-danger' : 'btn-ghost')}
      >
        <Mic aria-hidden />
      </button>
      </p>
      <div className="grid gap-1.5 rounded-lg border border-input bg-secondary p-2 transition-colors focus-within:border-ring">
        <label htmlFor="chat-composer" className="sr-only">Ask a spatial question</label>
        <textarea
          ref={ref}
          id="chat-composer"
          rows={2}
          value={voice.recording && voice.interim ? `${value}${value ? ' ' : ''}${voice.interim}` : value}
          maxLength={MAX_LENGTH}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={pointFocus ? 'Ask about the point you picked…' : 'Ask a spatial question…'}
          className="block max-h-[7.5rem] min-h-10 w-full resize-none bg-transparent px-0.5 text-body leading-normal text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex flex-wrap items-center justify-between gap-x-1.5 gap-y-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <button type="button" className={tool} onClick={() => openDialog('add-data')} data-testid="composer-add-data">
              <Paperclip aria-hidden /><span className="whitespace-nowrap max-[400px]:sr-only">Add data</span>
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className={tool} data-testid="prompt-ideas">
                  <Lightbulb aria-hidden /><span className="whitespace-nowrap max-[400px]:sr-only">Prompt ideas</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(21.25rem,calc(100vw-2rem))] p-1">
                <p className="px-2 pb-1 pt-1.5 text-muted-foreground text-label">Prompt ideas</p>
                <ul>
                  {IDEAS.map((q) => (
                    <li key={q}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(q)
                          window.setTimeout(() => ref.current?.focus(), 0)
                        }}
                        className="menu-item"
                      >
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          </div>
          {isLoading ? (
            <button type="button" onClick={onCancel} aria-label="Stop" title="Stop" className="btn btn-secondary btn-sm">
              <Square className="fill-current" aria-hidden />Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title={aoi ? 'Send (Enter)' : 'Draw an area first'}
              data-testid="send"
              className="btn btn-primary btn-sm"
            >
              Ask Erdfeld <Send aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
