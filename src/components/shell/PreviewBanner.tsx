'use client'

/**
 * P6.2 — Read-only preview banner.
 *
 * Shown only when the viewer opened a `/share/:token` link (`previewMode`). Makes
 * "this is someone else's frozen snapshot" unmistakable and offers the only edit
 * path: forking a private copy under the viewer's own anonymous owner token.
 */

import { useCallback, useState } from 'react'
import { Eye, GitFork, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useStore } from '@/store/useStore'
import { getOwnerToken, toDto, type ProjectDto } from '@/lib/projects'
import { Button } from '@/components/ui/button'

export default function PreviewBanner() {
  const previewMode = useStore((s) => s.previewMode)
  const previewMeta = useStore((s) => s.previewMeta)
  const exitPreview = useStore((s) => s.exitPreview)
  const setCurrentProjectId = useStore((s) => s.setCurrentProjectId)
  const [forking, setForking] = useState(false)

  const handleFork = useCallback(async () => {
    setForking(true)
    try {
      const s = useStore.getState()
      const dto: ProjectDto = toDto({
        name: `${previewMeta?.name ?? 'Shared project'} (copy)`,
        aoi: s.aoi,
        mapStyle: s.mapStyle,
        layers: s.layers,
        messages: s.messages,
      })
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-token': getOwnerToken() },
        body: JSON.stringify(dto),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Fork failed')
      // Now the viewer owns this copy — drop preview mode and adopt the new id.
      setCurrentProjectId(data.id)
      exitPreview()
      toast.success(`Forked "${dto.name}" into your projects`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForking(false)
    }
  }, [previewMeta, exitPreview, setCurrentProjectId])

  if (!previewMode) return null

  const snapshotDate = previewMeta?.updatedAt
    ? new Date(previewMeta.updatedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

  return (
    <div className="absolute top-0 inset-x-0 z-30 flex justify-center px-3 pt-3 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl bg-warning/15 border border-warning/40 px-3.5 py-2 shadow-lg max-w-[42.5rem] animate-fade-in-up">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warning/20">
          <Eye className="h-3.5 w-3.5 text-warning" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-semibold text-warning truncate">
            Shared snapshot{previewMeta?.name ? ` — ${previewMeta.name}` : ''} · read-only
          </span>
          <span className="text-xs text-warning">
            {snapshotDate ? `Snapshot of ${snapshotDate}. ` : ''}Fork to edit your own copy.
          </span>
        </div>
        <div className="flex items-center gap-1.5 ml-1 shrink-0">
          <Button
            size="sm"
            className="h-7 bg-warning hover:bg-warning/90 text-warning-foreground text-xs font-medium gap-1.5"
            disabled={forking}
            onClick={handleFork}
          >
            {forking ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitFork className="h-3 w-3" />}
            Fork to my projects
          </Button>
          <button
            type="button"
            onClick={exitPreview}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-warning hover:text-warning hover:bg-warning/10 transition-colors"
            title="Dismiss banner"
            aria-label="Dismiss preview banner"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
