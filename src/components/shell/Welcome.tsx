'use client'

import { Search } from 'lucide-react'
import SampleCases from '@/components/shell/SampleCases'
import { Button } from '@/components/ui/button'
import { useUi } from '@/store/useUi'
import type { SampleCase } from '@/lib/sample-cases'

/** The first thing seen: what this is in one line, a primary way in, and three cases that were run
 *  end to end. No illustration and no motion; the map beside it is the picture. */
export default function Welcome({ onPickSample }: { onPickSample: (c: SampleCase) => void }) {
  const setPanelMode = useUi((s) => s.setPanelMode)
  return (
    <div className="grid gap-6 py-4" data-testid="welcome">
      <div>
        <h2 className="font-heading text-2xl font-semibold leading-tight tracking-[-0.015em] text-foreground">Ask the ground a question</h2>
        <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-muted-foreground">
          Draw an area and ask. You get the answer with its sources, dates and limits, and every number links to the data behind it.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => setPanelMode('investigate')} data-testid="investigate-cta"><Search aria-hidden />Investigate an area</Button>
          <span className="text-xs text-muted-foreground">or draw an area and ask below</span>
        </div>
      </div>
      <SampleCases onPick={onPickSample} />
    </div>
  )
}
