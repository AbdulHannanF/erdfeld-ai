'use client'

import { useCallback, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { FolderOpen, Save, Trash2, Layers as LayersIcon, MessageSquare, Plus, Loader2, FolderClosed, Share2 } from 'lucide-react'
import { toast } from 'sonner'

import { useStore } from '@/store/useStore'
import {
  fromDto,
  getOwnerToken,
  toDto,
  type ProjectDto,
  type ProjectSummary,
} from '@/lib/projects'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { apiErrorMessage } from '@/lib/api-errors'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Saved projects: save the session, reopen or delete one, copy a read-only share link. The
 *  caller supplies the button that opens it. */
export default function ProjectsPanel({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  const currentProjectId = useStore((s) => s.currentProjectId)
  const loadProject = useStore((s) => s.loadProject)
  const setCurrentProjectId = useStore((s) => s.setCurrentProjectId)
  const setProjectName = useStore((s) => s.setProjectName)

  const authHeaders = useCallback(
    (): HeadersInit => ({
      'Content-Type': 'application/json',
      'x-owner-token': getOwnerToken(),
    }),
    [],
  )

  const refresh = useCallback(async () => {
    setListLoading(true)
    try {
      const res = await fetch('/api/projects', { headers: { 'x-owner-token': getOwnerToken() } })
      const data = await res.json()
      setProjects(Array.isArray(data.projects) ? data.projects : [])
    } catch {
      toast.error('Could not load saved projects')
    } finally {
      setListLoading(false)
    }
  }, [])

  // Refresh the list whenever the panel opens (driven from onOpenChange below).
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open)
      if (open) refresh()
    },
    [refresh],
  )

  // Build the persistable snapshot from current store state (read at click time
  // so the panel doesn't re-render on every layer/message change).
  const buildDto = useCallback((projectName: string): ProjectDto => {
    const s = useStore.getState()
    return toDto({
      name: projectName,
      aoi: s.aoi,
      mapStyle: s.mapStyle,
      layers: s.layers,
      messages: s.messages,
    })
  }, [])

  const handleSaveNew = useCallback(async () => {
    const s = useStore.getState()
    if (!s.aoi && s.layers.length === 0 && s.messages.filter((m) => m.content).length === 0) {
      toast.error('Nothing to save yet — draw an AOI or run an analysis first.')
      return
    }
    setSaving(true)
    try {
      const dto = buildDto(name.trim() || `Project ${projects.length + 1}`)
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(dto),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Save failed'))
      setCurrentProjectId(data.id)
      setProjectName(dto.name)
      setName('')
      toast.success(`Saved "${dto.name}"`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [name, projects.length, buildDto, authHeaders, setCurrentProjectId, setProjectName, refresh])

  const handleUpdate = useCallback(async () => {
    if (!currentProjectId) return handleSaveNew()
    setSaving(true)
    try {
      const current = projects.find((p) => p.id === currentProjectId)
      const dto = buildDto(name.trim() || current?.name || 'Untitled project')
      const res = await fetch(`/api/projects/${currentProjectId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(dto),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Update failed'))
      setProjectName(dto.name)
      toast.success(`Updated "${dto.name}"`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }, [currentProjectId, projects, name, buildDto, authHeaders, refresh, handleSaveNew, setProjectName])

  const handleLoad = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/projects/${id}`, { headers: { 'x-owner-token': getOwnerToken() } })
        const data = await res.json()
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Load failed'))
        const restored = fromDto(data.project as ProjectDto)
        loadProject({ id, ...restored })
        setProjectName((data.project as ProjectDto).name)
        setIsOpen(false)
        toast.success(`Opened "${(data.project as ProjectDto).name}"`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Load failed')
      }
    },
    [loadProject, setProjectName],
  )

  const handleShare = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        const res = await fetch(`/api/projects/${id}/share`, {
          method: 'POST',
          headers: { 'x-owner-token': getOwnerToken() },
        })
        const data = await res.json()
        if (!res.ok) throw new Error(apiErrorMessage(data, 'Could not create share link'))
        try {
          await navigator.clipboard.writeText(data.url)
          toast.success('Share link copied', { description: 'Read-only — anyone with the link can view this snapshot.' })
        } catch {
          toast.success('Share link created', { description: data.url })
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not create share link')
      }
    },
    [],
  )

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        const res = await fetch(`/api/projects/${id}`, {
          method: 'DELETE',
          headers: { 'x-owner-token': getOwnerToken() },
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(apiErrorMessage(data, 'Delete failed'))
        }
        if (currentProjectId === id) setCurrentProjectId(null)
        setProjects((prev) => prev.filter((p) => p.id !== id))
        toast.success('Project deleted')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Delete failed')
      }
    },
    [currentProjectId, setCurrentProjectId],
  )

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-[21.25rem] bg-card border-l border-border p-0">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-brand-text" />
            Projects
            {projects.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground font-normal">
                {projects.length}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>

        {/* Save form */}
        <div className="px-4 py-3 border-b border-border bg-foreground/[0.02]">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (currentProjectId) handleUpdate()
              else handleSaveNew()
            }}
            placeholder={currentProjectId ? 'Rename (optional)…' : 'Project name…'}
            className="field"
          />
          <div className="flex items-center gap-1.5 mt-2">
            {currentProjectId ? (
              <>
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={saving}
                  onClick={handleUpdate}
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Update current
                </Button>
                <Button
                  size="sm"
                  variant="ghost"

                  disabled={saving}
                  onClick={handleSaveNew}
                  title="Save as a new project"
                >
                  <Plus className="h-3 w-3" />
                  New
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="flex-1"
                disabled={saving}
                onClick={handleSaveNew}
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save project
              </Button>
            )}
          </div>
          {currentProjectId && (
            <p className="mt-1.5 text-caption text-muted-foreground">
              Editing a saved project — “Update” overwrites it, “New” forks a copy.
            </p>
          )}
        </div>

        {/* Project list */}
        <ScrollArea className="h-[calc(100vh-11.25rem)]">
          <div className="flex flex-col gap-1 p-2">
            {listLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-caption">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 px-4">
                <FolderClosed className="h-7 w-7 text-muted-foreground" />
                <p className="text-caption text-muted-foreground text-center leading-relaxed">
                  No saved projects yet.
                  <br />
                  Draw an AOI, run an analysis, then save it here to reopen later.
                </p>
              </div>
            ) : (
              projects.map((p) => {
                const active = p.id === currentProjectId
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleLoad(p.id)}
                    className={`group flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ${
                      active
                        ? 'bg-brand-500/10 border-brand-500/30'
                        : 'bg-card/50 border-border hover:bg-muted/50 hover:border-brand-500/20'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption-strong text-foreground truncate flex-1">
                        {p.name}
                        {active && (
                          <span className="ml-1.5 text-caption text-brand-text font-normal">· open</span>
                        )}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleShare(p.id, e)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') handleShare(p.id, e as unknown as React.MouseEvent)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-sm hover:bg-primary/20 text-muted-foreground hover:text-brand-text transition-all cursor-pointer"
                          title="Copy read-only share link"
                        >
                          <Share2 className="h-3 w-3" />
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleDelete(p.id, e)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') handleDelete(p.id, e as unknown as React.MouseEvent)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-sm hover:bg-danger/20 text-muted-foreground hover:text-danger transition-all cursor-pointer"
                          title="Delete project"
                        >
                          <Trash2 className="h-3 w-3" />
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 text-caption text-muted-foreground">
                      <span className="flex items-center gap-0.5">
                        <LayersIcon className="h-2.5 w-2.5" />
                        {p.layerCount}
                      </span>
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="h-2.5 w-2.5" />
                        {p.messageCount}
                      </span>
                      <span className="font-mono ml-auto">
                        {formatDistanceToNow(new Date(p.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
