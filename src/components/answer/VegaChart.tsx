'use client'

import dynamic from 'next/dynamic'

/** Generic Vega-Lite renderer, code-split: vega / vega-lite / vega-embed load on first use.
 *  This is the single chart path — agent charts, auto-charted array figures and the
 *  dashboard templates all go through it. */
const VegaChart = dynamic(() => import('@/components/answer/VegaChartView'), {
  ssr: false,
  loading: () => <div className="h-[11.25rem] w-full animate-pulse rounded-md bg-foreground/5" aria-hidden />,
})

export default VegaChart
