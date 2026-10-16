'use client'

import { useCallback } from 'react'
import { FileText, FileJson, FileCheck2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { buildReproducibleExport } from '@/lib/reproducible-export'
import type { LedgerExport } from '@/app/api/agent/engine/ledger'
import { getOwnerToken } from '@/lib/projects'
import { downloadBundle, openSummary } from '@/components/evidence/ledger-actions'
import { ringAreaM2 } from '@/lib/geo-ops'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

function exportAsMarkdown(messages: ReturnType<typeof useStore.getState>['messages'], toolCalls: ReturnType<typeof useStore.getState>['toolCalls'], layers: ReturnType<typeof useStore.getState>['layers']) {
  const lines: string[] = [
    '# Erdfeld AI analysis report',
    '',
    `**Date:** ${new Date().toLocaleString()}`,
    `**Total Queries:** ${messages.filter((m) => m.role === 'user').length}`,
    `**Tools Executed:** ${toolCalls.filter((t) => t.status === 'completed').length}`,
    `**Map Layers:** ${layers.length}`,
    '',
    '---',
    '',
  ]

  for (const msg of messages) {
    if (!msg.content) continue
    const time = new Date(msg.timestamp).toLocaleTimeString()
    if (msg.role === 'user') {
      lines.push(`## You [${time}]`)
      lines.push('')
      lines.push(msg.content)
    } else {
      lines.push(`## Erdfeld AI [${time}]`)
      lines.push('')
      lines.push(msg.content)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  if (layers.length > 0) {
    lines.push('## Map Layers')
    lines.push('')
    for (const layer of layers) {
      lines.push(`- **${layer.name}** (${layer.type}) — ${layer.visible ? 'visible' : 'hidden'}, opacity: ${Math.round(layer.opacity * 100)}%`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function exportAsJSON(messages: ReturnType<typeof useStore.getState>['messages'], toolCalls: ReturnType<typeof useStore.getState>['toolCalls'], layers: ReturnType<typeof useStore.getState>['layers'], aoi: ReturnType<typeof useStore.getState>['aoi']) {
  return JSON.stringify({
    exportDate: new Date().toISOString(),
    aoi: aoi ? { type: aoi.type, center: aoi.center, radiusKm: aoi.radiusKm } : null,
    messages: messages.filter((m) => m.content).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp).toISOString(),
    })),
    toolCalls: toolCalls.map((tc) => ({
      tool: tc.toolName,
      status: tc.status,
      label: tc.label,
    })),
    layers: layers.map((l) => ({
      name: l.name,
      type: l.type,
      visible: l.visible,
      opacity: l.opacity,
    })),
  }, null, 2)
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** The export actions as a list: the Export popover and the Layouts & reports dialog share it. */
export function ExportList() {
  const messages = useStore((s) => s.messages)
  const toolCalls = useStore((s) => s.toolCalls)
  const layers = useStore((s) => s.layers)
  const aoi = useStore((s) => s.aoi)
  const toolResults = useStore((s) => s.toolResults)
  const ledgerRunIds = useStore((s) => s.ledgerRunIds)

  const hasContent = messages.some((m) => m.content)

  const handleExportMarkdown = useCallback(() => {
    const md = exportAsMarkdown(messages, toolCalls, layers)
    const dateStr = new Date().toISOString().slice(0, 10)
    downloadFile(md, `erdfeld-report-${dateStr}.md`, 'text/markdown')
    toast.success('Report exported as Markdown')
  }, [messages, toolCalls, layers])

  const handleExportJSON = useCallback(() => {
    const json = exportAsJSON(messages, toolCalls, layers, aoi)
    const dateStr = new Date().toISOString().slice(0, 10)
    downloadFile(json, `erdfeld-data-${dateStr}.json`, 'application/json')
    toast.success('Data exported as JSON')
  }, [messages, toolCalls, layers, aoi])

  const handleExportReproducible = useCallback(async () => {
    // Honest area: spherical-shoelace over a Polygon outer ring, else null.
    let areaKm2: number | null = null
    const geom = aoi?.geometry as GeoJSON.Geometry | undefined
    if (geom?.type === 'Polygon') {
      const ring = (geom.coordinates?.[0] ?? []) as [number, number][]
      if (ring.length >= 4) areaKm2 = ringAreaM2(ring) / 1e6
    }
    // Q-47 — the evidence ledger of each request. A run that cannot be fetched is reported, not omitted silently.
    const ledger: LedgerExport[] = []
    const missing: string[] = []
    await Promise.all(ledgerRunIds.map(async (id) => {
      try {
        const res = await fetch(`/api/ledger/${id}`, { headers: { 'x-owner-token': getOwnerToken() } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        ledger.push((await res.json()) as LedgerExport)
      } catch {
        missing.push(id)
      }
    }))
    ledger.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const exportObj = buildReproducibleExport({
      ledger,
      aoi: aoi ? { type: aoi.type, geometry: aoi.geometry, center: aoi.center, radiusKm: aoi.radiusKm } : null,
      areaKm2,
      toolResults,
      layers: layers.map((l) => ({
        id: l.id, name: l.name, type: l.type, tool: l.tool, resultId: l.resultId,
        provenance: l.provenance, confidence: l.confidence,
      })),
      messages: messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })),
    })
    const dateStr = new Date().toISOString().slice(0, 10)
    downloadFile(JSON.stringify(exportObj, null, 2), `erdfeld-reproducible-${dateStr}.json`, 'application/json')
    toast.success(`Reproducible export — ${exportObj.steps.length} cited step(s), ${ledger.length} ledger run(s)`)
    if (missing.length) toast.warning(`${missing.length} ledger run(s) could not be fetched and are not in the export`)
  }, [aoi, toolResults, layers, messages, ledgerRunIds])


  const latestRun = ledgerRunIds[ledgerRunIds.length - 1]

  const item = 'menu-item items-start'

  return (
    <>
    {!hasContent ? (
      <p className="px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
        Nothing to export yet. Ask a question about the area first.
      </p>
    ) : (
      <div className="flex flex-col gap-0.5">
        <span className="px-2.5 pb-1 pt-1.5 text-muted-foreground text-label">Export</span>
        {latestRun && (
          <>
            <button type="button" onClick={() => void downloadBundle(latestRun)} className={item}>
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>
                <span className="block text-body-strong text-foreground">Signed evidence bundle</span>
                <span className="block text-caption text-muted-foreground">Ed25519-signed ledger of the latest run</span>
              </span>
            </button>
            <button type="button" onClick={() => void openSummary(latestRun)} className={item}>
              <FileCheck2 className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />
              <span>
                <span className="block text-body-strong text-foreground">One-page PDF summary</span>
                <span className="block text-caption text-muted-foreground">Restates the signed bundle</span>
              </span>
            </button>
          </>
        )}
        <button type="button" onClick={handleExportReproducible} className={item}>
          <FileCheck2 className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />
          <span>
            <span className="block text-body-strong text-foreground">Reproducible JSON</span>
            <span className="block text-caption text-muted-foreground">Cited figures and provenance, re-runnable</span>
          </span>
        </button>
        <button type="button" onClick={handleExportMarkdown} className={item}>
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-body-strong text-foreground">Markdown report</span>
            <span className="block text-caption text-muted-foreground">The conversation and the layers</span>
          </span>
        </button>
        <button type="button" onClick={handleExportJSON} className={item}>
          <FileJson className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-body-strong text-foreground">JSON data</span>
            <span className="block text-caption text-muted-foreground">Structured, for other tools</span>
          </span>
        </button>
        {!latestRun && (
          <p className="px-2.5 pb-1.5 pt-1 text-caption leading-relaxed text-muted-foreground">
            The signed bundle appears once a question has run and its ledger is saved.
          </p>
        )}
      </div>
    )}
    </>
  )
}

export default function ExportMenu({ children, align = "end", side = "bottom" }: { children: React.ReactNode; align?: "start" | "center" | "end"; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} side={side} sideOffset={8} className="w-64 p-1.5">
        <ExportList />
      </PopoverContent>
    </Popover>
  )
}
