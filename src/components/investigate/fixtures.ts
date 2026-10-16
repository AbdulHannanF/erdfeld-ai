import type { InvestigationEvent } from '@/lib/investigation-events'

/**
 * Recorded event streams for the board's preview page and tests. They follow the provisional
 * contract in `lib/investigation-events.ts` and are SYNTHETIC: the numbers and the "articles"
 * are invented to exercise every state, so the preview labels them as a fixture and nothing here
 * may be shown as a result for a real place.
 */

const CELLS = [
  { bbox: [74.02, 31.1, 74.06, 31.14] as [number, number, number, number], score: 0.91 },
  { bbox: [74.06, 31.1, 74.1, 31.14] as [number, number, number, number], score: 0.64 },
  { bbox: [74.02, 31.14, 74.06, 31.18] as [number, number, number, number], score: 0.38 },
  { bbox: [74.06, 31.14, 74.1, 31.18] as [number, number, number, number], score: 0.22 },
]

const HYPOTHESES: Extract<InvestigationEvent, { type: 'hypotheses' }>['items'] = [
  { id: 'harvest', label: 'Rice harvest and stubble clearing', family: 'Land use', prior: 0.3 },
  { id: 'flood', label: 'Flood inundation', family: 'Hydrology', prior: 0.2 },
  { id: 'drought', label: 'Drought or heat stress', family: 'Climate', prior: 0.2 },
  { id: 'burn', label: 'Crop-residue burning', family: 'Land use', prior: 0.15 },
  { id: 'artefact', label: 'Cloud or haze artefact', family: 'Data quality', prior: 0.15 },
]

/** A run that reaches a verdict, with one flagged piece of evidence and two ruled-out hypotheses. */
export const FIXTURE_RESOLVED: InvestigationEvent[] = [
  { type: 'discovery', cells: CELLS, chosen: 0 },
  { type: 'hypotheses', items: HYPOTHESES },
  { type: 'step', n: 1, op: 'fetch_ndvi', why: 'A real change must show in two clear scenes, not one reading.', voi: 0.62 },
  {
    type: 'evidence', n: 1, resultId: 'r_5f0c2a91b7d3e480', status: 'ok',
    summary: 'Mean NDVI fell from 0.71 to 0.37 across 61% of clear pixels (two scenes, 14 days apart).',
    features: { ndvi_before: 0.71, ndvi_after: 0.37, changed_pct: 61 },
  },
  { type: 'belief', n: 1, posteriors: { harvest: 0.38, flood: 0.17, drought: 0.22, burn: 0.16, artefact: 0.07 } },
  { type: 'step', n: 2, op: 'detect_water', why: 'Flooding would leave open water on radar; the other causes would not.', voi: 0.48 },
  {
    type: 'evidence', n: 2, resultId: 'r_a3d19e0c44b2f7d1', status: 'ok',
    summary: 'Open water covers 0.4% of the area, the same as the dry reference date.',
    features: { water_pct: 0.4, water_pct_reference: 0.4 },
  },
  { type: 'belief', n: 2, posteriors: { harvest: 0.47, flood: 0.01, drought: 0.27, burn: 0.19, artefact: 0.06 } },
  { type: 'step', n: 3, op: 'fetch_thermal_anomaly', why: 'Burning leaves active-fire detections; a harvest alone does not.', voi: 0.41 },
  {
    type: 'evidence', n: 3, resultId: 'r_09be7746c1a85d32', status: 'flagged',
    summary: 'No active-fire detections, but the satellite missed 2 of the 14 days, so the absence is weak evidence.',
    features: { fire_detections: 0, days_observed: 12, days_window: 14 },
  },
  { type: 'belief', n: 3, posteriors: { harvest: 0.55, flood: 0.01, drought: 0.3, burn: 0.09, artefact: 0.05 } },
  { type: 'step', n: 4, op: 'analyze_phenology', why: 'Drought fades vegetation over weeks; a harvest drops it within days, field by field.', voi: 0.37 },
  {
    type: 'evidence', n: 4, resultId: 'r_e47c6d8a02f19b55', status: 'ok',
    summary: 'The decline happened within 7 days and follows field boundaries.',
    features: { decline_days: 7, field_aligned_pct: 83 },
  },
  { type: 'belief', n: 4, posteriors: { harvest: 0.78, flood: 0.01, drought: 0.12, burn: 0.07, artefact: 0.02 } },
  {
    type: 'corroboration',
    note: 'Reports published in the same weeks. They describe the season; they are not measurements of this area.',
    sources: [
      { title: 'Harvest season begins across the district (synthetic example)', url: 'https://example.org/fixture/harvest', publisher: 'Example Gazette', date: '2026-09-24', inWindow: true },
      { title: 'Fertiliser prices ahead of the wheat sowing (synthetic example)', url: 'https://example.org/fixture/prices', publisher: 'Example Agri Weekly', date: '2026-08-02', inWindow: false },
    ],
  },
  { type: 'verdict', kind: 'hypothesis', id: 'harvest', label: 'Rice harvest and stubble clearing', posterior: 0.78, decidingEvidence: [1, 4] },
  { type: 'dossier', summary: 'Four operations, one of them flagged. The vegetation drop is most probably a harvest.', runId: 'fixture-run-1' },
]

/** A run that cannot separate the hypotheses and says so. */
export const FIXTURE_UNDETERMINED: InvestigationEvent[] = [
  { type: 'discovery', cells: CELLS, chosen: 1 },
  { type: 'hypotheses', items: HYPOTHESES.slice(0, 4) },
  { type: 'step', n: 1, op: 'fetch_ndvi', why: 'A real change must show in two clear scenes, not one reading.', voi: 0.55 },
  {
    type: 'evidence', n: 1, resultId: 'r_7c21d0ae93b5f610', status: 'ok',
    summary: 'Mean NDVI fell from 0.58 to 0.49 across 22% of clear pixels (only two usable scenes in 40 days).',
    features: { ndvi_before: 0.58, ndvi_after: 0.49, changed_pct: 22 },
  },
  { type: 'belief', n: 1, posteriors: { harvest: 0.33, flood: 0.17, drought: 0.3, burn: 0.2 } },
  { type: 'step', n: 2, op: 'detect_water', why: 'Flooding would leave open water on radar.', voi: 0.4 },
  {
    type: 'evidence', n: 2, resultId: 'r_2b9f3c5d81ae0467', status: 'failed',
    summary: 'The radar scenes could not be read (the data service returned an error). This is a failed fetch, not an absence of water.',
    features: {},
  },
  { type: 'belief', n: 2, posteriors: { harvest: 0.33, flood: 0.17, drought: 0.3, burn: 0.2 } },
  { type: 'verdict', kind: 'cannot_determine', label: 'Cannot determine', posterior: 0.33, decidingEvidence: [] },
  { type: 'dossier', summary: 'Not enough clear data to separate harvest from drought; the radar check failed.', runId: 'fixture-run-2' },
]

export const INVESTIGATION_FIXTURES = {
  resolved: FIXTURE_RESOLVED,
  undetermined: FIXTURE_UNDETERMINED,
} as const

export type FixtureName = keyof typeof INVESTIGATION_FIXTURES
