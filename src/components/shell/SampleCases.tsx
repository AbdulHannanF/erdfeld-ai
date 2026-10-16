'use client'

import { ArrowRight } from 'lucide-react'
import { SAMPLE_CASES, type SampleCase } from '@/lib/sample-cases'

/** The three verified cases. Picking one sets its area and asks its question; the agent runs the
 *  tools, nothing here is a canned answer. */
export default function SampleCases({ onPick }: { onPick: (c: SampleCase) => void }) {
  return (
    <section aria-label="Sample cases">
      <h3 className="mb-1 text-muted-foreground text-label">Start from a sample case</h3>
      <ul className="divide-y divide-border border-y border-border">
        {SAMPLE_CASES.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c)}
              data-testid={`sample-${c.id}`}
              className="menu-item"
            >
              <span className="min-w-0">
                <span className="block text-body-strong leading-snug text-foreground">{c.title}</span>
                <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">{c.why}</span>
                <span className="mt-1.5 block text-caption text-muted-foreground">
                  <span className="font-semibold text-foreground">{c.source}</span> · {c.sourceDetail} · {c.place}
                </span>
                {c.note && <span className="mt-1 block text-caption text-muted-foreground">{c.note}</span>}
              </span>
              <ArrowRight className="mt-0.5 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
