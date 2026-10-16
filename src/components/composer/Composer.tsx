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

const tool =
  'inline-flex h-7 items-center gap-1.5 rounded px-1.5 text-[0.7813rem] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground [&_svg]:size-3.5'

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
        className={cn('mx-0.5 mb-[0.4375rem] flex items-center gap-1.5 text-[0.8125rem]', aoi ? 'text-muted-foreground' : 'text-warning')}
        data-testid="composer-aoi"
      >
        {aoi ? <Check className="size-3.5 shrink-0 text-[#78c49a]" aria-hidden /> : <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate" role="status">
          {aoi ? `${aoi.type} area${km2 != null ? ` · ${formatAreaKm2(km2)}` : ''} selected · ready to ask` : 'Draw an area before asking'}
        </span>
        <span className="ml-auto" />
        {pointFocus && (
          <span className="inline-flex min-w-0 items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">
            <span className="truncate tabular-nums">Point {pointFocus.lat.toFixed(3)}, {pointFocus.lng.toFixed(3)}</span>
            <button type="button" onClick={() => setPointFocus(null)} aria-label="Clear the picked point" className="rounded hover:text-foreground">
              <X className="size-3" aria-hidden />
            </button>
          </span>
        )}
      <button
        type="button"
        onClick={voice.toggle}
        aria-pressed={voice.recording}
        aria-label={voice.recording ? 'Stop voice input' : 'Dictate the question (Ctrl+M)'}
        title={voice.recording ? 'Stop voice input' : 'Dictate the question (Ctrl+M)'}
        className={cn(tool, 'ml-1 shrink-0 px-1.5', voice.recording && 'bg-danger/10 text-danger')}
      >
        <Mic aria-hidden />
      </button>
      </p>
      <div className="grid gap-1.5 rounded-lg border border-[#38413f] bg-secondary p-2 transition-colors focus-within:border-[#57816b] focus-within:bg-secondary">
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
          className="block max-h-[7.5rem] min-h-10 w-full resize-none bg-transparent px-0.5 text-[0.875rem] leading-normal text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-1.5">
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
                <p className="px-2 pb-1 pt-1.5 font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Prompt ideas</p>
                <ul>
                  {IDEAS.map((q) => (
                    <li key={q}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(q)
                          window.setTimeout(() => ref.current?.focus(), 0)
                        }}
                        className="block w-full rounded px-2 py-1.5 text-left text-[0.8125rem] leading-snug text-foreground hover:bg-hover"
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
            <button type="button" onClick={onCancel} aria-label="Stop" title="Stop" className="inline-flex h-8 items-center gap-1.5 rounded border border-input bg-secondary px-2.5 text-[0.8125rem] font-semibold text-foreground hover:bg-hover">
              <Square className="size-3 fill-current" aria-hidden />Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title={aoi ? 'Send (Enter)' : 'Draw an area first'}
              data-testid="send"
              className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded border border-[#49966b] bg-[#267e58] px-2.5 text-[0.8125rem] font-semibold text-[#f2f7f3] transition-colors hover:bg-[#32966b] disabled:pointer-events-none disabled:opacity-45"
            >
              Ask Erdfeld <Send className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
