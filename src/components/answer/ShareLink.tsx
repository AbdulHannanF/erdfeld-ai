'use client'

import { useCallback, useState } from 'react'
import { Check, Link2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { getOwnerToken, toDto } from '@/lib/projects'
import { apiErrorMessage } from '@/lib/api-errors'
import { Button } from '@/components/ui/button'

/** A read-only link to a snapshot of this session (area, layers and conversation). A session that
 *  is not saved yet is saved as a project first, so the link has something to point at. Nobody
 *  who opens it can change the original: they fork their own copy. */
export default function ShareLink({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const share = useCallback(async () => {
    setBusy(true)
    try {
      const headers = { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() }
      const s = useStore.getState()
      let id = s.currentProjectId
      if (!id) {
        const first = s.messages.find((m) => m.role === 'user')?.content.slice(0, 60)
        const dto = toDto({ name: first || 'Shared analysis', aoi: s.aoi, mapStyle: s.mapStyle, layers: s.layers, messages: s.messages })
        const saved = await fetch('/api/projects', { method: 'POST', headers, body: JSON.stringify(dto) })
        const body = await saved.json()
        if (!saved.ok) throw new Error(apiErrorMessage(body, 'The session could not be saved'))
        id = body.id as string
        s.setCurrentProjectId(id)
      }
      const res = await fetch(`/api/projects/${id}/share`, { method: 'POST', headers: { 'x-owner-token': getOwnerToken() } })
      const data = await res.json()
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Could not create the link'))
      try {
        await navigator.clipboard.writeText(data.url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        toast.success('Read-only link copied', { description: 'Anyone with the link can view this snapshot, not change it.' })
      } catch {
        toast.success('Read-only link created', { description: data.url })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the link')
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <Button variant="outline" size="sm" onClick={share} disabled={busy} className={className}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
      {copied ? 'Link copied' : 'Share link'}
    </Button>
  )
}
