'use client'

import type { ChartItem } from '@/lib/chart-spec'
import { specHasFid } from '@/lib/chart-spec'
import VegaChart from '@/components/answer/VegaChart'

/** One agent-made (`make_chart`) Vega-Lite chart in a titled card. Used under the answer
 *  in chat and in the analysis dashboard. */
export default function ChartCard({ chart, height }: { chart: ChartItem; height?: number }) {
  const linked = !!chart.layerId && specHasFid(chart.spec)
  return (
    <div className="not-prose mt-2 rounded-lg border border-border bg-foreground/10 p-2.5" data-testid="agent-chart">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{chart.title}</span>
        {linked && <span className="shrink-0 text-xs text-muted-foreground">click a mark to find it on the map</span>}
      </div>
      <VegaChart spec={chart.spec} layerId={chart.layerId} height={height} />
    </div>
  )
}
