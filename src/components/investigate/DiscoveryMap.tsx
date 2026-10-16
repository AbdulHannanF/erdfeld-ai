'use client'

import type { InvestigationState } from '@/components/investigate/state'

const W = 280
const H = 120

/** Where the investigation looked: the candidate cells it scored, drawn to scale, with the one it
 *  chose outlined. Shading is the score; the numbers are listed beside it, never only in colour. */
export function DiscoveryMap({ discovery }: { discovery: NonNullable<InvestigationState['discovery']> }) {
  const { cells, chosen } = discovery
  if (cells.length === 0) return null
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const c of cells) {
    w = Math.min(w, c.bbox[0]); s = Math.min(s, c.bbox[1]); e = Math.max(e, c.bbox[2]); n = Math.max(n, c.bbox[3])
  }
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180)
  const spanX = (e - w) * k || 1e-9
  const spanY = n - s || 1e-9
  const scale = Math.min((W - 8) / spanX, (H - 8) / spanY)
  const ox = (W - spanX * scale) / 2
  const oy = (H - spanY * scale) / 2
  const max = Math.max(...cells.map((c) => c.score ?? 0), 1e-9)
  const rect = (c: (typeof cells)[number]) => ({
    x: ox + (c.bbox[0] - w) * k * scale,
    y: oy + (n - c.bbox[3]) * scale,
    width: (c.bbox[2] - c.bbox[0]) * k * scale,
    height: (c.bbox[3] - c.bbox[1]) * scale,
  })

  return (
    <div className="grid gap-3" data-testid="discovery">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="rounded-md border border-border bg-muted" role="img" aria-label={`${cells.length} candidate cells${chosen >= 0 ? ', the highest-scoring one chosen' : ', none could be scored'}`}>
        {cells.map((c, i) => (
          <rect key={i} {...rect(c)} fill={c.score == null ? 'none' : 'var(--teal)'} fillOpacity={c.score == null ? 0 : 0.1 + 0.55 * (c.score / max)} stroke="var(--border)" strokeWidth={1} strokeDasharray={c.score == null ? '3 2' : undefined}><title>{c.score == null ? `Not scored${c.reason ? `: ${c.reason}` : ''}` : `score ${c.score.toFixed(2)}`}</title></rect>
        ))}
        {cells[chosen] && <rect {...rect(cells[chosen])} fill="none" stroke="var(--foreground)" strokeWidth={2} />}
      </svg>
      <ol className="min-w-0 text-xs">
        {cells.map((c, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 py-0.5 tabular-nums">
            <span className={i === chosen ? 'font-medium text-foreground' : 'text-muted-foreground'}>Cell {i + 1}{i === chosen ? ' (chosen)' : ''}</span>
            <span className="text-muted-foreground" title={c.reason}>{c.score == null ? 'not scored' : `score ${c.score.toFixed(2)}`}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
