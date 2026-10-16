'use client'

import ClassFilter from '@/components/map/ClassFilter'
import LayerPanel from '@/components/map/LayerPanel'
import DistributionBar from '@/components/answer/DistributionBar'
import FieldInspector from '@/components/answer/FieldInspector'
import { OVERLINE } from '@/components/shell/ui'
import { useStore } from '@/store/useStore'

/** The Layers tab: the layer list (visibility, opacity, style, legend, download), the class filter
 *  of a categorical layer, the distribution of what it found, and the inspector for the feature
 *  picked on the map or in the table. These were part of the answer; they belong to the layers. */
export default function LayersTab() {
  const count = useStore((s) => s.layers.length)
  const hasClasses = useStore((s) => s.layers.some((l) => l.visible && l.vectorStyle?.kind === 'categorical'))
  const isLoading = useStore((s) => s.isLoading)

  return (
    <section aria-label="Layers" data-testid="layers-tab" className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className={OVERLINE}>Map</p>
          <h2 className="mt-1 font-heading text-panel text-foreground">Layers</h2>
        </div>
        <span className="badge badge-accent">{count}</span>
      </div>
      <LayerPanel />
      {hasClasses && (
        <section aria-label="Classes" className="grid gap-1.5">
          <h3 className={OVERLINE}>Classes</h3>
          <ClassFilter />
        </section>
      )}
      {!isLoading && <DistributionBar />}
      {!isLoading && <FieldInspector />}
    </section>
  )
}
