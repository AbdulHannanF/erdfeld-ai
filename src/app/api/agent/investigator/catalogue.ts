/**
 * The hypothesis catalogue: data, not code paths (like `recipes/*.yaml`).
 *
 * A family names the competing explanations for one kind of observed change. Its evidence items
 * say which registered operation produces a measurement (op + argument template), which feature
 * of the result is read, and how that feature is cut into bins (every cut carries its reason).
 * Each hypothesis then declares, per item, the probability of each bin if it were true. The
 * belief engine (`belief.ts`) turns those into likelihood ratios; the selector (`select.ts`) uses
 * the same numbers as the predicted outcome distribution when it prices an item.
 *
 * Calibration: every probability here is expert judgement from the physics of the measure, with
 * the reason beside it. None is fitted to labelled data. The investigator's output says so.
 * The LLM never touches these numbers.
 */

import { z } from 'zod'

export const FAMILY_IDS = ['water', 'vegetation_loss', 'fire', 'structures'] as const
export type FamilyId = (typeof FAMILY_IDS)[number]

export const CALIBRATION_NOTE =
  'The likelihoods behind this verdict are expert judgement from the physics of each measurement, not fitted to labelled data; treat posteriors as a structured ranking, not calibrated probabilities.'

/** Where a measured value falls: numeric cuts (bin i holds cuts[i-1] <= x < cuts[i]) or named categories. */
export type Scale =
  | { kind: 'cuts'; unit: string; cuts: Array<{ at: number; why: string }> }
  | { kind: 'categories'; categories: Array<{ value: string; why: string }> }

export type Sensor = 'optical' | 'radar' | 'archive' | 'vector' | 'live'

export type ArgValue = string | number | boolean

export interface EvidenceItem {
  id: string
  title: string
  /** A registered operation (engine/registry). */
  op: string
  /** Arguments; a string `{{window.start}}`, `{{window.end}}`, `{{window.end_month}}` or `{{window.days_to_now}}` is filled from the window. */
  args: Record<string, ArgValue>
  sensor: Sensor
  /** Name of an extractor in `features.ts`, or `vision` for a vision-model reading of a chip. */
  feature: string
  scale: Scale
  /** Clamp on the likelihood ratio of this item. A vision reading is an interpretation, not a measurement. */
  lrCap?: [number, number]
  /** Needs the window to end within this many days of today (near-real-time sources). */
  liveWithinDays?: number
  /** Needs a window at least this long (comparisons against a whole-year anniversary). */
  minWindowDays?: number
  /** What this evidence would settle, for the "evidence that would decide it" list. */
  decides: string
  /** A limit the reader must carry with this evidence. */
  caveat?: string
  /** False when the item does not observe the event window: a baseline, an archive that ends before it, a
   *  quality check on the other evidence. Such items move belief but can never confirm an event on their own
   *  (the stopping rule and the verdict need at least one item that did observe the window). Default: true
   *  for optical, radar and live sensors, false for archive and vector (current map) sources. */
  observesWindow?: boolean
}

/** Does a measurement from this item say anything about what happened inside the window? */
export function observesWindow(item: Pick<EvidenceItem, 'sensor' | 'observesWindow'>): boolean {
  return item.observesWindow ?? (item.sensor !== 'archive' && item.sensor !== 'vector')
}

export interface Prediction {
  /** P(bin | hypothesis), one per bin of the item's scale. Sums to 1; none below 0.01 so no outcome is ruled out outright. */
  p: number[]
  why: string
}

export interface Hypothesis {
  id: string
  label: string
  description: string
  /** Used only when the model proposes nothing usable. */
  defaultPrior: number
  /** Per item id. An item a hypothesis does not mention is uninformative for it (uniform). */
  predicts: Record<string, Prediction>
}

export interface Family {
  id: FamilyId
  title: string
  /** What question this family answers (shown to the model that picks the family). */
  about: string
  hypotheses: Hypothesis[]
  items: EvidenceItem[]
  /** Temporal and data limits stated with every dossier of this family. */
  limits: string[]
}

export const MIN_PROB = 0.01

export function binCount(scale: Scale): number {
  return scale.kind === 'cuts' ? scale.cuts.length + 1 : scale.categories.length
}

/** The bin a value falls in, or -1 when the value does not belong to the scale. */
export function binOf(scale: Scale, value: number | string): number {
  if (scale.kind === 'categories') return scale.categories.findIndex((c) => c.value === value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1
  const i = scale.cuts.findIndex((c) => value < c.at)
  return i === -1 ? scale.cuts.length : i
}

export function binLabel(scale: Scale, bin: number): string {
  if (scale.kind === 'categories') return scale.categories[bin]?.value ?? '?'
  const { cuts, unit } = scale
  if (bin === 0) return `< ${cuts[0].at} ${unit}`.trim()
  if (bin === cuts.length) return `>= ${cuts[cuts.length - 1].at} ${unit}`.trim()
  return `${cuts[bin - 1].at} to ${cuts[bin].at} ${unit}`.trim()
}

// ---------------------------------------------------------------------------
// Shared argument templates (identical args across families share one execution)
// ---------------------------------------------------------------------------

// `bracket`: the window is where the event happened, so the before scene must not be later than its
// start nor the after scene earlier than its end. Without it the clearest scene within +/-30 days of
// each date can fall inside the window, and a before scene taken after the event hides it.
const change = (index: string, extra: Record<string, ArgValue> = {}): Record<string, ArgValue> => ({
  operation: 'change', index, date: '{{window.start}}', date2: '{{window.end}}', bracket: true, ...extra,
})
const NBR_CHANGE = change('NBR', { threshold: 0.1 })
/** Burn change measured on burnable ground only. NBR = (NIR - SWIR2) / (NIR + SWIR2): green and dry
 *  vegetation reflect more NIR than SWIR2 (about 0.2 to 0.8; senescent grass 0.1 to 0.3), while
 *  roofs, asphalt and bare rock sit near zero (about -0.1 to 0.1). A cut of 0.15 keeps cover that
 *  can burn and drops surfaces that cannot, so a burnt town does not wash out a vegetation index.
 *  The share of the area it keeps is reported with the result, so the reader sees how much it covers. */
const NBR_CHANGE_BURNABLE = change('NBR', { threshold: 0.1, baseline_min: 0.15 })
const NDVI_CHANGE = change('NDVI')
const BUILT_SURFACE: Record<string, ArgValue> = {}
const FIRE_WATCH: Record<string, ArgValue> = { days: '{{window.days_to_now}}' }
const IMAGERY = (question: string): Record<string, ArgValue> => ({ date: '{{window.end}}', question })

const cat = (...pairs: Array<[string, string]>): Scale => ({ kind: 'categories', categories: pairs.map(([value, why]) => ({ value, why })) })

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

const WATER: Family = {
  id: 'water',
  title: 'Water: flood, inundation or something else',
  about: 'New or unusual water, flooding, inundation, a lake or river that changed, dark patches on radar.',
  limits: [
    'Sentinel-1 radar misses water under vegetation and among dense buildings, so flooded area is a lower bound there.',
    'The JRC surface-water history ends in 2021; it says what was usual, not what happened in the window.',
    'Optical change compares two single scenes (the dates actually used are reported); cloud on either date removes pixels.',
  ],
  items: [
    {
      id: 'sar_new_water', title: 'New water between a dry and a wet Sentinel-1 pass', op: 'map_flood',
      args: { start: '{{window.start}}', end: '{{window.end}}', include_roads: false },
      sensor: 'radar', feature: 'newly_flooded_fraction',
      scale: {
        kind: 'cuts', unit: 'of the observed area',
        cuts: [
          { at: 0.02, why: 'Below about 2% the new-water mask is within what speckle and threshold choice produce on dry land.' },
          { at: 0.1, why: 'A tenth of the area newly wet is a clear change of surface, but a single irrigation round can do it.' },
          { at: 0.3, why: 'Above 30% newly wet is widespread inundation; field-scale irrigation rarely wets this much at once.' },
        ],
      },
      decides: 'whether water appeared that was not there on a dry reference pass',
    },
    {
      id: 'sar_prior_water', title: 'Water already present on the dry reference pass', op: 'map_flood',
      args: { start: '{{window.start}}', end: '{{window.end}}', include_roads: false },
      sensor: 'radar', feature: 'pre_event_water_fraction',
      scale: {
        kind: 'cuts', unit: 'of the observed area',
        cuts: [
          { at: 0.05, why: 'Under 5% is a dry reference with only channels or small ponds.' },
          { at: 0.4, why: 'Over 40% means most of the area was already water before the event.' },
        ],
      },
      decides: 'whether the water is new or was already there',
    },
    {
      id: 'sar_orbit_geometry', title: 'Radar geometry of the two passes', op: 'map_flood', observesWindow: false,
      args: { start: '{{window.start}}', end: '{{window.end}}', include_roads: false },
      sensor: 'radar', feature: 'sar_orbit_match',
      scale: cat(
        ['orbit', 'Same relative orbit: like is compared with like, so a dark change is a surface change.'],
        ['direction', 'Same flight direction, different track: incidence angle differs a little.'],
        ['any', 'Different geometry: incidence-angle differences can pass for water change.'],
      ),
      decides: 'whether the radar pair can be trusted to show a surface change',
    },
    {
      id: 'jrc_history', title: 'Long-term water occurrence (JRC, 1984-2021)', op: 'fetch_surface_water',
      args: BUILT_SURFACE, sensor: 'archive', feature: 'water_occurrence_pct',
      scale: {
        kind: 'cuts', unit: '% of years',
        cuts: [
          { at: 5, why: 'Under 5% of observed years: the place is normally dry.' },
          { at: 25, why: '25% or more of years with water is a seasonal or permanent water body.' },
        ],
      },
      decides: 'whether water here is usual (permanent or seasonal) or unusual',
      caveat: 'Ends in 2021; it is a baseline, not an observation of the window.',
    },
    {
      id: 'optical_ndwi_change', title: 'Optical water-index change (Sentinel-2 NDWI)', op: 'analyze_raster',
      args: change('NDWI'), sensor: 'optical', feature: 'ndwi_rise',
      scale: {
        kind: 'cuts', unit: 'NDWI',
        cuts: [
          { at: 0.02, why: 'Under 0.02 is within scene-to-scene noise of the mean index.' },
          { at: 0.06, why: 'Open water raises NDWI by about 0.5 per pixel, so 0.06 on the mean means roughly a tenth of the area.' },
          { at: 0.15, why: 'A mean rise of 0.15 means a third or more of the area turned to water.' },
        ],
      },
      decides: 'an independent, optical sign of new water (needs a clear sky on both dates)',
      caveat: 'Cloud and shadow on either date remove pixels; wet soil also raises NDWI.',
    },
    {
      id: 'water_vision', title: 'A vision model looks at the true-colour scene', op: 'inspect_imagery',
      args: IMAGERY('Is there standing water over fields, roads or buildings, only water inside a channel or lake, or irrigated fields? Is cloud covering the ground?'),
      sensor: 'optical', feature: 'vision', lrCap: [0.5, 2],
      scale: cat(
        ['floodwater_over_land', 'Water spreading beyond channels over fields or settlements.'],
        ['water_in_channel_or_lake_only', 'Water confined to a river, canal or lake.'],
        ['irrigated_or_paddy_fields', 'Regular flooded parcels typical of irrigation.'],
        ['no_visible_water', 'No water in view.'],
        ['cloud_or_shadow_dominates', 'The ground cannot be read.'],
      ),
      decides: 'what the scene shows to the eye',
      caveat: 'A vision reading is an interpretation of a picture; its weight is capped.',
    },
  ],
  hypotheses: [
    {
      id: 'water_flood_event', label: 'Flood event', description: 'Water spread over land that was dry, from river overflow or heavy rain.', defaultPrior: 0.4,
      predicts: {
        sar_new_water: { p: [0.05, 0.15, 0.3, 0.5], why: 'A flood leaves a large newly wet fraction.' },
        sar_prior_water: { p: [0.55, 0.4, 0.05], why: 'The area was mostly dry before.' },
        sar_orbit_geometry: { p: [0.6, 0.3, 0.1], why: 'Geometry is independent of the event; most pairs match.' },
        jrc_history: { p: [0.45, 0.4, 0.15], why: 'Floodplains are often dry in most years but wet in some.' },
        optical_ndwi_change: { p: [0.1, 0.2, 0.35, 0.35], why: 'New water raises NDWI when the sky is clear.' },
        water_vision: { p: [0.55, 0.1, 0.05, 0.1, 0.2], why: 'Floodwater over land is visible unless cloud hides it.' },
      },
    },
    {
      id: 'water_seasonal_inundation', label: 'Seasonal or irrigation inundation', description: 'Regular wetting of fields or floodplain with the season or irrigation schedule.', defaultPrior: 0.25,
      predicts: {
        sar_new_water: { p: [0.15, 0.3, 0.35, 0.2], why: 'Paddy and irrigation add new water, usually patchy and moderate.' },
        sar_prior_water: { p: [0.35, 0.55, 0.1], why: 'Some parcels already wet.' },
        sar_orbit_geometry: { p: [0.6, 0.3, 0.1], why: 'Independent of the cause.' },
        jrc_history: { p: [0.2, 0.55, 0.25], why: 'Recurrent wetting shows up as intermediate occurrence.' },
        optical_ndwi_change: { p: [0.2, 0.3, 0.3, 0.2], why: 'Flooded parcels raise NDWI, less widely than a flood.' },
        water_vision: { p: [0.1, 0.1, 0.5, 0.1, 0.2], why: 'Regular flooded parcels look like irrigation.' },
      },
    },
    {
      id: 'water_permanent', label: 'Permanent water', description: 'A lake, reservoir or river that is always there; nothing new.', defaultPrior: 0.15,
      predicts: {
        sar_new_water: { p: [0.85, 0.12, 0.02, 0.01], why: 'By definition almost no new water.' },
        sar_prior_water: { p: [0.03, 0.17, 0.8], why: 'Already water on the reference date.' },
        sar_orbit_geometry: { p: [0.6, 0.3, 0.1], why: 'Independent of the cause.' },
        jrc_history: { p: [0.03, 0.12, 0.85], why: 'A water body shows high occurrence over 37 years.' },
        optical_ndwi_change: { p: [0.7, 0.2, 0.08, 0.02], why: 'No change in the index.' },
        water_vision: { p: [0.05, 0.6, 0.05, 0.1, 0.2], why: 'Water stays within its basin.' },
      },
    },
    {
      id: 'water_radar_artefact', label: 'Radar artefact', description: 'Dark radar surfaces that are not water: shadow, smooth bare soil, wet soil, wind, or a mismatched pass pair.', defaultPrior: 0.2,
      predicts: {
        sar_new_water: { p: [0.45, 0.35, 0.15, 0.05], why: 'Spurious dark patches are small and scattered.' },
        sar_prior_water: { p: [0.4, 0.45, 0.15], why: 'No particular pattern.' },
        sar_orbit_geometry: { p: [0.2, 0.3, 0.5], why: 'A mismatched pair is a typical source of false change.' },
        jrc_history: { p: [0.5, 0.35, 0.15], why: 'No particular pattern.' },
        optical_ndwi_change: { p: [0.5, 0.3, 0.15, 0.05], why: 'Optical sees no water where radar was fooled.' },
        water_vision: { p: [0.05, 0.1, 0.1, 0.55, 0.2], why: 'The ground is dry in the picture.' },
      },
    },
  ],
}

// ---------------------------------------------------------------------------
// Vegetation loss
// ---------------------------------------------------------------------------

const VEGETATION: Family = {
  id: 'vegetation_loss',
  title: 'Vegetation loss: harvest, clearing, fire, drought or artefact',
  about: 'Greenness dropped, a field or forest looks browner or bare, NDVI fell, trees or crops are gone.',
  limits: [
    'Change compares two single Sentinel-2 scenes; a seasonal difference between their dates reads as change.',
    'NDVI and NBR changes are averages over the drawn area, so a loss in a small part of it is diluted.',
    'Spectral change shows that vegetation changed, not why; the cause comes from combining several measures.',
  ],
  items: [
    {
      id: 'veg_ndvi_change', title: 'NDVI change between the start and end of the window', op: 'analyze_raster',
      args: NDVI_CHANGE, sensor: 'optical', feature: 'ndvi_drop',
      scale: {
        kind: 'cuts', unit: 'NDVI',
        cuts: [
          { at: 0.05, why: 'Under 0.05 is within the scene-to-scene variation of a stable surface.' },
          { at: 0.15, why: 'A 0.15 fall in the mean is a clear loss of green cover over a large share of the area.' },
          { at: 0.3, why: 'A fall above 0.3 means most of the area went from vegetated to bare or burnt.' },
        ],
      },
      decides: 'how much green cover was lost between the two dates',
    },
    {
      id: 'veg_dnbr', title: 'Burn severity index (dNBR) between the two dates', op: 'analyze_raster',
      args: NBR_CHANGE, sensor: 'optical', feature: 'dnbr',
      scale: {
        kind: 'cuts', unit: 'dNBR',
        cuts: [
          { at: 0.1, why: 'USGS FIREMON class boundary: below 0.10 is unburned or regrowth.' },
          { at: 0.27, why: 'USGS class boundary: 0.10 to 0.27 is low severity.' },
          { at: 0.44, why: 'USGS class boundary: above 0.44 is moderate-high to high severity.' },
        ],
      },
      decides: 'whether the loss has the spectral signature of burning (SWIR and NIR move together)',
      caveat: 'Averaged over the drawn area; the sign convention is pre minus post.',
    },
    {
      id: 'veg_anomaly', title: 'Was the end month unusual against its own history', op: 'detect_anomaly',
      args: { month: '{{window.end_month}}' }, sensor: 'optical', feature: 'within_expected_range',
      scale: cat(
        ['within_expected', 'Inside the 80% range expected from the preceding years.'],
        ['below_expected', 'Below that range: lower than this month usually is.'],
        ['above_expected', 'Above that range: greener than usual.'],
      ),
      decides: 'whether a drop is normal for the season or unusual',
      caveat: 'The expected value is a forecast from history; about one month in five falls outside the range by chance.',
    },
    {
      id: 'veg_hotspots', title: 'Active fire detections (near real time)', op: 'fetch_active_fires',
      args: FIRE_WATCH, sensor: 'live', feature: 'active_fire_count', liveWithinDays: 10,
      scale: {
        kind: 'cuts', unit: 'detections',
        cuts: [
          { at: 1, why: 'None detected.' },
          { at: 5, why: 'One to four detections: a small or short fire, or one thermal source.' },
          { at: 25, why: 'Five to 24: a sustained fire; 25 or more is a large one.' },
        ],
      },
      decides: 'whether something was burning in the last days',
      caveat: 'Only the last days are observable; it says nothing about an older window.',
    },
    {
      id: 'veg_vision', title: 'A vision model looks at the true-colour scene', op: 'inspect_imagery',
      args: IMAGERY('Is the ground bare and cleared, dark and burnt, brown and dry, harvested in a field pattern, still green, or covered by cloud or shadow?'),
      sensor: 'optical', feature: 'vision', lrCap: [0.5, 2],
      scale: cat(
        ['cleared_bare_ground', 'Geometric bare patches or roads cut into vegetation.'],
        ['dark_burn_scar', 'Dark or black ground, smoke, charred patches.'],
        ['brown_dry_vegetation', 'Vegetation still present but brown or sparse.'],
        ['harvested_field_pattern', 'Field-shaped parcels of stubble or bare soil.'],
        ['vegetation_intact', 'Green cover looks intact.'],
        ['cloud_or_shadow_dominates', 'The ground cannot be read.'],
      ),
      decides: 'what the scene shows to the eye',
      caveat: 'A vision reading is an interpretation of a picture; its weight is capped.',
    },
  ],
  hypotheses: [
    {
      id: 'veg_harvest_senescence', label: 'Harvest or seasonal senescence', description: 'Crops harvested or vegetation dying back with the season.', defaultPrior: 0.25,
      predicts: {
        veg_ndvi_change: { p: [0.05, 0.25, 0.45, 0.25], why: 'Harvest drops NDVI a lot over the harvested share.' },
        veg_dnbr: { p: [0.25, 0.45, 0.25, 0.05], why: 'Drying lowers NBR modestly; burning lowers it much more.' },
        veg_anomaly: { p: [0.7, 0.2, 0.1], why: 'The season explains it, so the month is within the usual range.' },
        veg_hotspots: { p: [0.85, 0.1, 0.04, 0.01], why: 'No fire expected.' },
        veg_vision: { p: [0.1, 0.02, 0.15, 0.55, 0.05, 0.13], why: 'Harvest leaves field-shaped patterns.' },
      },
    },
    {
      id: 'veg_clearing', label: 'Clearing or deforestation', description: 'Vegetation removed by logging, land clearing or construction.', defaultPrior: 0.25,
      predicts: {
        veg_ndvi_change: { p: [0.03, 0.12, 0.4, 0.45], why: 'Clearing removes cover outright.' },
        veg_dnbr: { p: [0.1, 0.35, 0.35, 0.2], why: 'NBR falls with biomass but less than with char.' },
        veg_anomaly: { p: [0.1, 0.8, 0.1], why: 'Far below what the season gives.' },
        veg_hotspots: { p: [0.8, 0.14, 0.05, 0.01], why: 'Slash fires are possible but not the norm.' },
        veg_vision: { p: [0.55, 0.05, 0.05, 0.05, 0.05, 0.25], why: 'Geometric bare patches.' },
      },
    },
    {
      id: 'veg_fire_burn_scar', label: 'Fire or burn scar', description: 'Vegetation burnt by a wildfire or a managed burn.', defaultPrior: 0.2,
      predicts: {
        veg_ndvi_change: { p: [0.03, 0.12, 0.4, 0.45], why: 'Burning removes green cover.' },
        veg_dnbr: { p: [0.03, 0.17, 0.35, 0.45], why: 'dNBR is the burn-severity index.' },
        veg_anomaly: { p: [0.1, 0.8, 0.1], why: 'Far below the usual range.' },
        veg_hotspots: { p: [0.4, 0.25, 0.2, 0.15], why: 'Detections are likely only if the fire is recent.' },
        veg_vision: { p: [0.1, 0.6, 0.02, 0.01, 0.02, 0.25], why: 'Dark scars and smoke.' },
      },
    },
    {
      id: 'veg_drought_stress', label: 'Drought stress', description: 'Vegetation browned by water shortage, still present.', defaultPrior: 0.15,
      predicts: {
        veg_ndvi_change: { p: [0.2, 0.55, 0.2, 0.05], why: 'A moderate fall without removal of cover.' },
        veg_dnbr: { p: [0.55, 0.35, 0.09, 0.01], why: 'NBR moves little.' },
        veg_anomaly: { p: [0.2, 0.7, 0.1], why: 'Below the usual range for the month.' },
        veg_hotspots: { p: [0.9, 0.07, 0.02, 0.01], why: 'No fire.' },
        veg_vision: { p: [0.02, 0.02, 0.6, 0.1, 0.1, 0.16], why: 'Brown, dry cover.' },
      },
    },
    {
      id: 'veg_cloud_shadow_artefact', label: 'Cloud or shadow artefact', description: 'The change is an effect of cloud, haze or shadow on one date, not of the ground.', defaultPrior: 0.15,
      predicts: {
        veg_ndvi_change: { p: [0.3, 0.35, 0.25, 0.1], why: 'Residual haze and shadow after masking give modest, noisy change.' },
        veg_dnbr: { p: [0.6, 0.3, 0.08, 0.02], why: 'Small and unsystematic.' },
        veg_anomaly: { p: [0.4, 0.4, 0.2], why: 'No particular pattern.' },
        veg_hotspots: { p: [0.9, 0.07, 0.02, 0.01], why: 'No fire.' },
        veg_vision: { p: [0.02, 0.02, 0.02, 0.02, 0.1, 0.82], why: 'Cloud or shadow is what the picture shows.' },
      },
    },
  ],
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

const FIRE: Family = {
  id: 'fire',
  title: 'Fire: wildfire, agricultural burning or not fire at all',
  about: 'A fire, smoke, a burn scar, scorched land or burnt buildings.',
  limits: [
    'Active-fire detections are near real time (the last days); they cannot confirm a fire in an older window.',
    'dNBR compares two single Sentinel-2 scenes and is averaged over the pixels that were vegetated before the event (NBR 0.15 or more); a fire smaller than that cover is still diluted.',
    'In built-up areas a burn is measured only on the trees, grass and gardens among the buildings. Burnt roofs and walls are not measured: the investigator has no building-damage measure, and if too little of the area was vegetated (under 30 pixels) the burn items are reported as not measurable rather than as zero.',
    'The historical burned-area products in the registry (MODIS MCD64A1 at 500 m, Copernicus CLMS at 300 m) are not used: they cannot be read in-app without credentials and are coarse for a drawn area of a few kilometres.',
    'Burn scars separate wildfire from agricultural burning only by extent and land cover, which are indirect.',
  ],
  items: [
    {
      id: 'fire_dnbr', title: 'Burn severity (dNBR) on the ground that was vegetated before', op: 'analyze_raster',
      args: NBR_CHANGE_BURNABLE, sensor: 'optical', feature: 'dnbr_burnable',
      scale: {
        kind: 'cuts', unit: 'dNBR',
        cuts: [
          { at: 0.1, why: 'USGS FIREMON class boundary: below 0.10 is unburned or regrowth.' },
          { at: 0.27, why: 'USGS class boundary: 0.10 to 0.27 is low severity.' },
          { at: 0.44, why: 'USGS class boundary: above 0.44 is moderate-high to high severity.' },
        ],
      },
      decides: 'whether the ground that could burn carries a burn signature and how severe it is',
      caveat: 'Averaged over the pixels with NBR of 0.15 or more before the event (the result states what share of the area that is); buildings and paved ground are not counted, so a burnt street shows only through the trees and grass around it. Sign convention is pre minus post.',
    },
    {
      id: 'fire_extent', title: 'Share of the vegetated ground where NBR fell', op: 'analyze_raster',
      args: NBR_CHANGE_BURNABLE, sensor: 'optical', feature: 'nbr_loss_fraction_burnable',
      scale: {
        kind: 'cuts', unit: 'of clear pixels',
        cuts: [
          { at: 0.05, why: 'Under 5% of the vegetated pixels fell by more than 0.1 NBR: no burn extent to speak of (scene-to-scene noise alone moves a few percent).' },
          { at: 0.2, why: 'A fifth of the vegetated ground is the scale of several burnt fields or one burnt block.' },
          { at: 0.5, why: 'Half the vegetated ground or more is a contiguous burn, typical of a wildfire that crossed the area.' },
        ],
      },
      decides: 'whether the burnt area is field-sized patches or a contiguous scar',
      caveat: 'Counted over vegetated pixels only (NBR 0.15 or more before the event), so it measures the burn on burnable cover, not the share of the drawn area.',
    },
    {
      id: 'fire_hotspots', title: 'Active fire detections (near real time)', op: 'fetch_active_fires',
      args: FIRE_WATCH, sensor: 'live', feature: 'active_fire_count', liveWithinDays: 10,
      scale: {
        kind: 'cuts', unit: 'detections',
        cuts: [
          { at: 1, why: 'None detected.' },
          { at: 5, why: 'One to four detections: a small or short fire, or one thermal source.' },
          { at: 25, why: 'Five to 24: a sustained fire; 25 or more is a large one.' },
        ],
      },
      decides: 'whether something was burning in the last days',
      caveat: 'Only the last days are observable; it says nothing about an older window.',
    },
    {
      id: 'fire_landcover', title: 'Land cover of the area (ESA WorldCover 2021)', op: 'fetch_built_surface',
      args: BUILT_SURFACE, sensor: 'archive', feature: 'cropland_pct',
      scale: {
        kind: 'cuts', unit: '% cropland',
        cuts: [
          { at: 10, why: 'Under 10% cropland: little to burn that is farmed.' },
          { at: 40, why: 'Over 40% cropland: stubble and residue burning is the likely source of burns.' },
        ],
      },
      decides: 'whether the burnt land is farmed',
      caveat: 'WorldCover is a single-year (2021) classification, about 75% accurate globally.',
    },
    {
      id: 'fire_vision', title: 'A vision model looks at the true-colour scene', op: 'inspect_imagery',
      args: IMAGERY('Is there a smoke plume, a dark burn scar, dark burnt field patches, intact vegetation, bare cleared ground, or is cloud covering the ground?'),
      sensor: 'optical', feature: 'vision', lrCap: [0.5, 2],
      scale: cat(
        ['burn_scar_or_smoke_plume', 'A large dark scar or a smoke plume.'],
        ['burnt_field_patches', 'Dark parcels with field boundaries.'],
        ['vegetation_intact', 'Green cover looks intact.'],
        ['bare_or_cleared_ground', 'Pale bare ground or cleared plots.'],
        ['cloud_or_shadow_dominates', 'The ground cannot be read.'],
      ),
      decides: 'what the scene shows to the eye',
      caveat: 'A vision reading is an interpretation of a picture; its weight is capped.',
    },
  ],
  hypotheses: [
    {
      id: 'fire_wildfire', label: 'Wildfire or burn scar', description: 'Uncontrolled burning of vegetation or settlement, leaving a contiguous burn scar.', defaultPrior: 0.4,
      predicts: {
        fire_dnbr: { p: [0.03, 0.17, 0.35, 0.45], why: 'dNBR is the burn-severity index.' },
        fire_extent: { p: [0.05, 0.15, 0.35, 0.45], why: 'A wildfire burns a contiguous large area.' },
        fire_hotspots: { p: [0.25, 0.25, 0.3, 0.2], why: 'Detections are likely only while it burns.' },
        fire_landcover: { p: [0.5, 0.3, 0.2], why: 'Wildland and mixed cover dominate.' },
        fire_vision: { p: [0.55, 0.05, 0.02, 0.03, 0.35], why: 'A scar or plume, unless cloud hides it.' },
      },
    },
    {
      id: 'fire_agricultural_burning', label: 'Agricultural burning', description: 'Planned burning of crop residue or fields.', defaultPrior: 0.25,
      predicts: {
        fire_dnbr: { p: [0.2, 0.4, 0.3, 0.1], why: 'Residue burns give low to moderate dNBR.' },
        fire_extent: { p: [0.35, 0.35, 0.25, 0.05], why: 'Patches of fields rather than one scar.' },
        fire_hotspots: { p: [0.3, 0.4, 0.25, 0.05], why: 'Short, small detections.' },
        fire_landcover: { p: [0.1, 0.25, 0.65], why: 'Farmland dominates.' },
        fire_vision: { p: [0.05, 0.5, 0.1, 0.1, 0.25], why: 'Dark field-shaped patches.' },
      },
    },
    {
      id: 'fire_non_fire_change', label: 'Change that is not fire', description: 'Vegetation change by harvest, clearing or drought, without burning.', defaultPrior: 0.2,
      predicts: {
        fire_dnbr: { p: [0.4, 0.4, 0.15, 0.05], why: 'NBR moves little without char.' },
        fire_extent: { p: [0.35, 0.35, 0.2, 0.1], why: 'No particular pattern.' },
        fire_hotspots: { p: [0.9, 0.08, 0.01, 0.01], why: 'No fire detections.' },
        fire_landcover: { p: [0.34, 0.33, 0.33], why: 'No particular pattern.' },
        fire_vision: { p: [0.02, 0.03, 0.4, 0.3, 0.25], why: 'No scar or plume.' },
      },
    },
    {
      id: 'fire_artefact', label: 'Artefact', description: 'Dark surfaces or shadow mistaken for burning, or a thermal source that is not fire.', defaultPrior: 0.15,
      predicts: {
        fire_dnbr: { p: [0.55, 0.3, 0.1, 0.05], why: 'Little spectral change.' },
        fire_extent: { p: [0.5, 0.3, 0.15, 0.05], why: 'Small and scattered.' },
        fire_hotspots: { p: [0.75, 0.2, 0.04, 0.01], why: 'Occasional false detection.' },
        fire_landcover: { p: [0.34, 0.33, 0.33], why: 'No particular pattern.' },
        fire_vision: { p: [0.05, 0.05, 0.3, 0.15, 0.45], why: 'Shadow or cloud, no scar.' },
      },
    },
  ],
}

// ---------------------------------------------------------------------------
// New structures / development
// ---------------------------------------------------------------------------

const STRUCTURES: Family = {
  id: 'structures',
  title: 'New structures and development: construction, demolition, temporary surfaces or a data artefact',
  about: 'New buildings, a development, a cleared plot, a site under construction, buildings that appeared or disappeared.',
  limits: [
    'A mapped building footprint (OpenStreetMap, Overture) is never proof that a building is new: those datasets record edit and release dates, not construction dates.',
    'ESA WorldCover is a single-year (2021) land-cover map: a baseline, not a change measure.',
    'Change compares two single Sentinel-2 scenes at 10 m; the dates actually used are reported, and a seasonal gap between them reads as change.',
    'Temporary structures (tents, stockpiles, greenhouses) look like construction in two dates; telling them apart needs a third date or sub-metre imagery.',
  ],
  items: [
    {
      id: 'struct_ndbi_change', title: 'Built-up index change (Sentinel-2 NDBI)', op: 'analyze_raster',
      args: change('NDBI'), sensor: 'optical', feature: 'ndbi_rise',
      scale: {
        kind: 'cuts', unit: 'NDBI',
        cuts: [
          { at: 0.02, why: 'Under 0.02 is within scene-to-scene variation.' },
          { at: 0.06, why: 'A rise of 0.06 in the mean means a visible share of the area changed from vegetated to built or bare.' },
          { at: 0.12, why: 'Above 0.12 means a large share of the area turned to built or bare surface.' },
        ],
      },
      decides: 'whether more of the area is built-up or bare than at the start',
      caveat: 'Bare soil also raises NDBI, so the index alone does not say it is a building.',
    },
    {
      id: 'struct_ndvi_change', title: 'NDVI change between the two dates', op: 'analyze_raster',
      args: NDVI_CHANGE, sensor: 'optical', feature: 'ndvi_drop',
      scale: {
        kind: 'cuts', unit: 'NDVI',
        cuts: [
          { at: 0.03, why: 'Under 0.03: vegetation cover did not change.' },
          { at: 0.1, why: 'A 0.10 fall: a noticeable share of the area lost vegetation.' },
          { at: 0.25, why: 'Above 0.25: most of the area lost vegetation, as when a plot is cleared.' },
        ],
      },
      decides: 'whether vegetation was replaced by something else',
    },
    {
      id: 'struct_season_alignment', title: 'Are the two scenes the same time of year', op: 'analyze_raster', observesWindow: false,
      args: change('NDBI'), sensor: 'optical', feature: 'anniversary_gap_days', minWindowDays: 330,
      scale: {
        kind: 'cuts', unit: 'days from a whole number of years',
        cuts: [
          { at: 30, why: 'Within a month of an exact anniversary the seasonal state is comparable.' },
          { at: 60, why: 'More than two months off an anniversary, season alone can produce the change.' },
        ],
      },
      decides: 'whether the apparent change is just two different seasons',
      caveat: 'Only meaningful for a window of about a year or more.',
    },
    {
      id: 'struct_baseline_builtup', title: 'Built-up share in 2021 (ESA WorldCover)', op: 'fetch_built_surface',
      args: BUILT_SURFACE, sensor: 'archive', feature: 'built_up_pct',
      scale: {
        kind: 'cuts', unit: '% built-up',
        cuts: [
          { at: 5, why: 'Under 5% built-up in 2021: the area was essentially undeveloped then.' },
          { at: 30, why: 'Over 30% built-up in 2021: already urban, so new built-up area is infill or replacement.' },
        ],
      },
      decides: 'whether the area was already built before the window',
      caveat: 'A 2021 baseline only; it cannot show change by itself.',
    },
    {
      id: 'struct_osm_density', title: 'Mapped buildings in OpenStreetMap', op: 'query_osm',
      args: { query: 'buildings' }, sensor: 'vector', feature: 'mapped_building_density_per_km2', lrCap: [0.67, 1.5],
      scale: {
        kind: 'cuts', unit: 'buildings per km2',
        cuts: [
          { at: 20, why: 'Under 20 per km2: sparsely mapped or truly empty.' },
          { at: 300, why: 'Over 300 per km2: densely mapped.' },
        ],
      },
      decides: 'how well the area is mapped, which tells whether an inventory could be out of date',
      caveat: 'OpenStreetMap records when a feature was edited, not when the building was built. A mapped footprint is not evidence that a building is new; this item is deliberately given little weight.',
    },
    {
      id: 'struct_vision', title: 'A vision model looks at the true-colour scene', op: 'inspect_imagery',
      args: IMAGERY('Are there buildings, foundations, or cleared plots? Established neighbourhoods, tents or stockpiles, greenhouse roofs, or only bare ground? Is cloud covering the ground?'),
      sensor: 'optical', feature: 'vision', lrCap: [0.5, 2],
      scale: cat(
        ['new_or_unfinished_buildings', 'Foundations, unfinished structures and cleared plots.'],
        ['established_buildings', 'Mature buildings and streets.'],
        ['temporary_structures', 'Tents, stockpiles or greenhouse roofs.'],
        ['bare_ground_no_structures', 'No structures visible.'],
        ['cloud_or_haze_dominates', 'The ground cannot be read.'],
      ),
      decides: 'what the scene shows to the eye',
      caveat: 'A single date cannot show that anything is new; the reading is capped.',
    },
  ],
  hypotheses: [
    {
      id: 'struct_construction', label: 'New construction', description: 'Buildings or infrastructure built within the window on previously open land.', defaultPrior: 0.4,
      predicts: {
        struct_ndbi_change: { p: [0.1, 0.25, 0.35, 0.3], why: 'Construction replaces vegetation with built and bare surface.' },
        struct_ndvi_change: { p: [0.08, 0.2, 0.37, 0.35], why: 'Plots are cleared before building.' },
        struct_season_alignment: { p: [0.7, 0.2, 0.1], why: 'Independent of the cause; most pairs are aligned.' },
        struct_baseline_builtup: { p: [0.5, 0.35, 0.15], why: 'New development mostly happens on land undeveloped in 2021.' },
        struct_osm_density: { p: [0.3, 0.45, 0.25], why: 'Weak: mapping lags construction either way.' },
        struct_vision: { p: [0.45, 0.2, 0.05, 0.1, 0.2], why: 'Foundations and cleared plots are visible.' },
      },
    },
    {
      id: 'struct_demolition', label: 'Demolition', description: 'Existing buildings removed, leaving bare ground.', defaultPrior: 0.15,
      predicts: {
        struct_ndbi_change: { p: [0.3, 0.35, 0.25, 0.1], why: 'Built to bare soil changes NDBI little.' },
        struct_ndvi_change: { p: [0.5, 0.3, 0.15, 0.05], why: 'Little vegetation involved.' },
        struct_season_alignment: { p: [0.7, 0.2, 0.1], why: 'Independent of the cause.' },
        struct_baseline_builtup: { p: [0.1, 0.3, 0.6], why: 'Demolition needs something built there.' },
        struct_osm_density: { p: [0.1, 0.4, 0.5], why: 'Weak: built areas are mapped.' },
        struct_vision: { p: [0.2, 0.1, 0.05, 0.45, 0.2], why: 'Bare ground where buildings were.' },
      },
    },
    {
      id: 'struct_temporary_surfaces', label: 'Temporary surfaces', description: 'Tents, stockpiles, greenhouses or storage that look like buildings in two dates but are not permanent.', defaultPrior: 0.15,
      predicts: {
        struct_ndbi_change: { p: [0.2, 0.35, 0.3, 0.15], why: 'Bright temporary surfaces raise NDBI moderately.' },
        struct_ndvi_change: { p: [0.25, 0.35, 0.3, 0.1], why: 'Moderate vegetation loss.' },
        struct_season_alignment: { p: [0.6, 0.25, 0.15], why: 'Seasonal structures are tied to season.' },
        struct_baseline_builtup: { p: [0.35, 0.4, 0.25], why: 'No particular pattern.' },
        struct_osm_density: { p: [0.4, 0.4, 0.2], why: 'Temporary features are rarely mapped.' },
        struct_vision: { p: [0.1, 0.1, 0.6, 0.1, 0.1], why: 'Tents, stockpiles or greenhouse roofs.' },
      },
    },
    {
      id: 'struct_imagery_mismatch', label: 'Image registration or date mismatch', description: 'The apparent change is from misaligned scenes, different seasons or different conditions, not from the ground.', defaultPrior: 0.15,
      predicts: {
        struct_ndbi_change: { p: [0.4, 0.35, 0.2, 0.05], why: 'Mostly small, noisy differences.' },
        struct_ndvi_change: { p: [0.35, 0.35, 0.2, 0.1], why: 'Seasonal NDVI differences can be large though.' },
        struct_season_alignment: { p: [0.1, 0.25, 0.65], why: 'Scenes far from an anniversary are the typical cause.' },
        struct_baseline_builtup: { p: [0.34, 0.33, 0.33], why: 'Independent of the cause.' },
        struct_osm_density: { p: [0.34, 0.33, 0.33], why: 'Independent of the cause.' },
        struct_vision: { p: [0.1, 0.25, 0.05, 0.25, 0.35], why: 'Nothing new is seen.' },
      },
    },
    {
      id: 'struct_outdated_inventory', label: 'Outdated building inventory', description: 'The buildings existed before the window and an older map or dataset simply lacks them.', defaultPrior: 0.15,
      predicts: {
        struct_ndbi_change: { p: [0.5, 0.3, 0.15, 0.05], why: 'The ground did not change in the window.' },
        struct_ndvi_change: { p: [0.5, 0.3, 0.15, 0.05], why: 'The ground did not change in the window.' },
        struct_season_alignment: { p: [0.7, 0.2, 0.1], why: 'Independent of the cause.' },
        struct_baseline_builtup: { p: [0.1, 0.35, 0.55], why: 'Buildings already present in 2021.' },
        struct_osm_density: { p: [0.45, 0.4, 0.15], why: 'Weak: a sparsely mapped area is how an inventory is out of date.' },
        struct_vision: { p: [0.05, 0.6, 0.05, 0.1, 0.2], why: 'Established buildings.' },
      },
    },
  ],
}

export const CATALOGUE: Family[] = [WATER, VEGETATION, FIRE, STRUCTURES]

export function getFamily(id: string): Family | undefined {
  return CATALOGUE.find((f) => f.id === id)
}

export function findHypothesis(id: string): { family: Family; hypothesis: Hypothesis } | undefined {
  for (const family of CATALOGUE) {
    const hypothesis = family.hypotheses.find((h) => h.id === id)
    if (hypothesis) return { family, hypothesis }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Schema: the catalogue is validated, so a bad edit fails a test, not an investigation
// ---------------------------------------------------------------------------

const ScaleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cuts'), unit: z.string(),
    cuts: z.array(z.object({ at: z.number().finite(), why: z.string().min(10) })).min(1),
  }),
  z.object({
    kind: z.literal('categories'),
    categories: z.array(z.object({ value: z.string().min(1), why: z.string().min(5) })).min(2),
  }),
])

const FamilySchema = z.object({
  id: z.enum(FAMILY_IDS),
  title: z.string().min(1),
  about: z.string().min(1),
  limits: z.array(z.string().min(10)).min(1),
  items: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), op: z.string().min(1),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    sensor: z.enum(['optical', 'radar', 'archive', 'vector', 'live']),
    feature: z.string().min(1),
    scale: ScaleSchema,
    lrCap: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    liveWithinDays: z.number().positive().optional(),
    minWindowDays: z.number().positive().optional(),
    decides: z.string().min(5),
    caveat: z.string().optional(),
  })).min(2),
  hypotheses: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1), description: z.string().min(1),
    defaultPrior: z.number().gt(0).lt(1),
    predicts: z.record(z.string(), z.object({ p: z.array(z.number()), why: z.string().min(5) })),
  })).min(2),
})

/** Every structural rule the engine relies on; returns the problems (empty when sound). */
export function validateCatalogue(families: Family[] = CATALOGUE): string[] {
  const problems: string[] = []
  const hypIds = new Set<string>()
  const itemIds = new Set<string>()
  for (const family of families) {
    const parsed = FamilySchema.safeParse(family)
    if (!parsed.success) {
      problems.push(`${family.id}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
      continue
    }
    const priorSum = family.hypotheses.reduce((s, h) => s + h.defaultPrior, 0)
    if (Math.abs(priorSum - 1) > 1e-9) problems.push(`${family.id}: default priors sum to ${priorSum}, not 1`)
    for (const item of family.items) {
      if (itemIds.has(item.id)) problems.push(`item id ${item.id} is used twice`)
      itemIds.add(item.id)
      if (item.scale.kind === 'cuts') {
        const ats = item.scale.cuts.map((c) => c.at)
        if (ats.some((a, i) => i > 0 && a <= ats[i - 1])) problems.push(`${item.id}: cuts are not strictly increasing`)
      }
      if (item.lrCap && !(item.lrCap[0] <= 1 && item.lrCap[1] >= 1 && item.lrCap[0] <= item.lrCap[1])) problems.push(`${item.id}: lrCap must bracket 1`)
      if (item.feature === 'vision' && !(item.lrCap && item.lrCap[0] >= 0.5 && item.lrCap[1] <= 2)) problems.push(`${item.id}: a vision item must cap its likelihood ratio within 0.5 to 2`)
      if (item.op === 'query_osm' && !(item.lrCap && item.lrCap[1] <= 1.5 && /not (?:evidence|construction)|never|not when/i.test(item.caveat ?? ''))) {
        problems.push(`${item.id}: a mapped-building item must be weakly weighted and say a footprint is not proof of a new building`)
      }
    }
    for (const h of family.hypotheses) {
      if (hypIds.has(h.id)) problems.push(`hypothesis id ${h.id} is used twice`)
      hypIds.add(h.id)
      for (const item of family.items) {
        const pred = h.predicts[item.id]
        if (!pred) { problems.push(`${h.id}: no prediction for ${item.id}`); continue }
        const n = binCount(item.scale)
        if (pred.p.length !== n) problems.push(`${h.id}/${item.id}: ${pred.p.length} probabilities for ${n} bins`)
        if (Math.abs(pred.p.reduce((s, x) => s + x, 0) - 1) > 1e-9) problems.push(`${h.id}/${item.id}: probabilities sum to ${pred.p.reduce((s, x) => s + x, 0)}`)
        if (pred.p.some((x) => x < MIN_PROB)) problems.push(`${h.id}/${item.id}: a probability is below ${MIN_PROB}`)
      }
      for (const key of Object.keys(h.predicts)) if (!family.items.some((i) => i.id === key)) problems.push(`${h.id}: predicts unknown item ${key}`)
    }
  }
  return problems
}
