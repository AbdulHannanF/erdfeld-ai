'use client'

import { useState } from 'react'
import { Camera, Check, Copy, Link2, Share2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import ShareLink from '@/components/answer/ShareLink'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { aoiAreaKm2, formatAreaKm2 } from '@/lib/aoi'
import { requestMapAction } from '@/lib/ui-events'

/** The ways to hand this work to someone else: a read-only snapshot link they can fork, a plain
 *  view link that reopens this place and area, the conversation as text, and a picture of the map. */
export default function ShareMenu({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
      toast.success(`${what} copied`)
    } catch {
      toast.error('The browser blocked copying. Select and copy manually.')
    }
  }

  const viewLink = () => {
    const { aoi, mapStyle } = useStore.getState()
    const p = new URLSearchParams()
    if (aoi?.center) {
      p.set('lat', aoi.center.lat.toFixed(6))
      p.set('lng', aoi.center.lng.toFixed(6))
      p.set('zoom', '12')
    }
    if (mapStyle) p.set('style', mapStyle)
    if (aoi?.geometry) p.set('aoi', JSON.stringify(aoi.geometry))
    return `${window.location.origin}${window.location.pathname}?${p.toString()}`
  }

  const summary = () => {
    const { aoi, messages } = useStore.getState()
    const km2 = aoiAreaKm2(aoi?.geometry)
    const lines = ['Erdfeld AI analysis', aoi ? `Area: ${aoi.type}${km2 != null ? `, ${formatAreaKm2(km2)}` : ''}` : 'Area: none', '']
    for (const m of messages) {
      if (!m.content || m.id.startsWith('quick-')) continue
      lines.push(`${m.role === 'user' ? 'Q' : 'A'}: ${m.content.replace(/\[\[[^\]]*\]\]/g, '').trim()}`, '')
    }
    return lines.join('\n').trim()
  }

  const item = 'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted'

  return (
    <Popover>
      <PopoverTrigger asChild>
        {children ?? (
          <Button variant="outline" size="sm"><Share2 aria-hidden />Share</Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5" data-testid="share-menu">
        <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <Users className="size-3.5" aria-hidden />Share and collaborate
        </p>
        <div className="px-1 pb-1"><ShareLink className="w-full justify-start" /></div>
        <button type="button" className={item} onClick={() => void copy('View link', viewLink())}>
          {copied === 'View link' ? <Check className="size-4 text-brand-text" aria-hidden /> : <Link2 className="size-4 text-muted-foreground" aria-hidden />}
          Copy a view link (place and area)
        </button>
        <button type="button" className={item} onClick={() => void copy('Summary', summary())}>
          {copied === 'Summary' ? <Check className="size-4 text-brand-text" aria-hidden /> : <Copy className="size-4 text-muted-foreground" aria-hidden />}
          Copy the conversation as text
        </button>
        <button type="button" className={item} onClick={() => requestMapAction('screenshot')}>
          <Camera className="size-4 text-muted-foreground" aria-hidden />
          Save a picture of the map
        </button>
      </PopoverContent>
    </Popover>
  )
}
