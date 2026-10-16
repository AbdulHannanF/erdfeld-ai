/** DN -> surface-reflectance transforms, resolved per STAC item — ISS-131.
 *
 *  ## What is actually wrong, measured
 *
 *  Every supported index is a ratio, so it is tempting to assume the DN->reflectance
 *  conversion cancels and can be skipped. **The scale cancels; an additive offset does
 *  not.** Sentinel-2 processing baseline 04.00 (Jan 2022) introduced
 *  `BOA_ADD_OFFSET = -1000`, and whether it is present in the pixels you receive depends
 *  entirely on **who served them**.
 *
 *  Measured live 2026-08-18, one polygon, same acquisition date (2026-08-15), remote
 *  Amazonas rainforest, red band:
 *
 *  | Served by                | red DN (p50) | reflectance if offset applied | plausible? |
 *  |--------------------------|--------------|-------------------------------|------------|
 *  | AWS earth-search         | 480          | **-0.052**                    | impossible |
 *  | Planetary Computer       | 1525         | +0.0525                       | correct    |
 *
 *  The ~1045 DN gap is the offset. Confirmed independently on deep clear water
 *  (Lake Nasser, SCL class 6 pixels only, earth-search, baseline 05.12): NIR mean
 *  **173 DN, minimum 2 DN**. Water NIR reflectance is ~0.00-0.02, so 0.0173 is right and
 *  the offset-applied -0.083 is impossible; a minimum of 2 DN is itself proof, because
 *  with the offset baked in no pixel can fall below ~1000.
 *
 *  ## The trap: the STAC metadata is wrong, and wrong in the confident direction
 *
 *  Earth-search declares `"raster:bands": [{"scale": 0.0001, "offset": -0.1}]` on every
 *  band of these items — **while serving pixels that have already had the offset
 *  removed**. Planetary Computer declares no `raster:bands` at all — **while serving
 *  pixels that still contain it**. Both catalogues describe themselves incorrectly, in
 *  opposite directions. An implementation that trusts `raster:bands` gets earth-search
 *  exactly backwards, which is how the first attempt at this fix produced NDVI of
 *  -1.09e11 and how the second (this one, before correction) produced NDVI of 1.77 over
 *  rainforest — a normalised difference cannot exceed 1.
 *
 *  So the transform is resolved from **who produced the item**, and the conclusion is
 *  then checked against the pixels (see `looksOverCorrected`) rather than believed.
 *
 *  ## Why this matters even though the old code "worked"
 *
 *  Reading raw DN was accidentally correct for earth-search, which is what
 *  `tools/satellite.ts` uses. It is **wrong for Planetary Computer**, which is what
 *  `tools/derived.ts` uses for `detect_change` and `detect_deforestation`. On PC, one
 *  Lake Nasser AOI reads NDVI -0.276 in a baseline-02.12 scene (2019) and -0.013 in a
 *  baseline-05.12 scene (2026) over the same water: a **processing-baseline change
 *  presented as a -0.26 NDVI change**. Any multi-year comparison spanning January 2022
 *  was measuring the offset, not the ground.
 *
 *  Applying the scale (even with a zero offset) is also what makes EVI and SAVI mean
 *  anything: their soil/canopy constants (`+1`, `+0.5`) are defined in reflectance
 *  units and vanish into rounding against DN in the thousands.
 */

/** Sentinel-2 L2A stores reflectance as uint16 at 1e-4. */
export const S2_REFLECTANCE_SCALE = 0.0001

/** Baseline 04.00 (2022-01-25) introduced BOA_ADD_OFFSET = -1000 DN = -0.1 reflectance. */
export const S2_BOA_OFFSET_BASELINE = 4.0

/** Who served the item. The offset question has a different answer for each. */
export type Producer = 'earth-search' | 'planetary-computer' | 'unknown'

export type TransformSource =
  | 'producer-earth-search'
  | 'producer-planetary-computer'
  | 'stac-declared'
  | 'sensor-default'

export interface ReflectanceTransform {
  /** Multiply the DN by this. */
  scale: number
  /** Then add this. */
  offset: number
  /** Where these numbers came from — surfaced in provenance, never guessed silently. */
  source: TransformSource
  /** Human-readable justification, for a `method` string. */
  note: string
  /** DN meaning "no data", when it is known. */
  nodata: number | null
}

/** Apply a transform to a raw DN. */
export function toReflectance(dn: number, t: ReflectanceTransform): number {
  return dn * t.scale + t.offset
}

/** Identify the catalogue that produced an item, from its own links and asset hrefs.
 *
 *  Host-based rather than collection-based because both catalogues use the collection
 *  id `sentinel-2-l2a`; the id says nothing about who processed the COGs. */
export function detectProducer(item: any): Producer {
  const hrefs: string[] = []
  for (const link of item?.links ?? []) if (typeof link?.href === 'string') hrefs.push(link.href)
  for (const asset of Object.values(item?.assets ?? {}) as any[]) {
    if (typeof asset?.href === 'string') hrefs.push(asset.href)
  }
  const blob = hrefs.join(' ').toLowerCase()
  if (blob.includes('earth-search.aws.element84.com') || blob.includes('sentinel-cogs')) {
    return 'earth-search'
  }
  if (blob.includes('planetarycomputer.microsoft.com') || blob.includes('blob.core.windows.net')) {
    return 'planetary-computer'
  }
  return 'unknown'
}

/** Parse `s2:processing_baseline` ("05.12", 4, "04.00") into a number, or null. */
export function parseProcessingBaseline(item: any): number | null {
  const raw =
    item?.properties?.['s2:processing_baseline'] ??
    item?.properties?.['processing:baseline'] ??
    null
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

/** Read `raster:bands[0]` off an asset, if the item declares one.
 *
 *  Kept because it is the right answer for any catalogue that describes itself
 *  accurately — but it is deliberately NOT consulted for the two Sentinel-2 producers
 *  above, both of which are known to declare something other than what they serve. */
export function declaredBandTransform(item: any, assetKey: string): ReflectanceTransform | null {
  const band = item?.assets?.[assetKey]?.['raster:bands']?.[0]
  if (!band || typeof band !== 'object') return null
  const hasScale = Number.isFinite(band.scale)
  const hasOffset = Number.isFinite(band.offset)
  if (!hasScale && !hasOffset) return null
  return {
    scale: hasScale ? Number(band.scale) : 1,
    offset: hasOffset ? Number(band.offset) : 0,
    source: 'stac-declared',
    note: `scale/offset declared by the STAC item on asset "${assetKey}"`,
    nodata: Number.isFinite(band.nodata) ? Number(band.nodata) : null,
  }
}

/** Identity transform — DN used as-is. Only correct when nothing else is known. */
export function identityTransform(why: string): ReflectanceTransform {
  return { scale: 1, offset: 0, source: 'sensor-default', note: why, nodata: null }
}

export interface ResolveOptions {
  /** Sensor-level fallback when nothing else applies (e.g. Landsat C2 L2). */
  fallback?: { scale: number; offset: number; note?: string }
  /** Set when the item is known to be Sentinel-2 L2A, enabling the producer rules. */
  isSentinel2?: boolean
}

/**
 * Resolve the DN->reflectance transform for one asset of one item.
 *
 * Never throws and never returns null: an unresolvable item yields the identity
 * transform, with `note` saying so, so a caller can print the truth instead of
 * implying a correction that did not happen.
 */
export function resolveReflectance(
  item: any,
  assetKey: string,
  opts: ResolveOptions = {},
): ReflectanceTransform {
  if (opts.isSentinel2) {
    const producer = detectProducer(item)

    if (producer === 'earth-search') {
      return {
        scale: S2_REFLECTANCE_SCALE,
        offset: 0,
        source: 'producer-earth-search',
        // Kept short because it is concatenated into every `method` string the user
        // can see; the evidence lives in this module's header.
        note: 'earth-search, BOA offset already removed by the producer',
        nodata: 0,
      }
    }

    if (producer === 'planetary-computer') {
      const baseline = parseProcessingBaseline(item)
      // PC serves the offset as-stored and declares nothing, so the baseline is the
      // only signal. Absent a baseline, assume the offset is present: since 2022 that
      // is true of every new acquisition, and under-correcting a modern scene is the
      // error that silently manufactures change across the 04.00 boundary.
      const offsetApplies = baseline == null || baseline >= S2_BOA_OFFSET_BASELINE
      return {
        scale: S2_REFLECTANCE_SCALE,
        offset: offsetApplies ? -0.1 : 0,
        source: 'producer-planetary-computer',
        note: offsetApplies
          ? `Planetary Computer, BOA offset -0.1 removed here (baseline ` +
            `${baseline == null ? 'undeclared, assumed >= 04.00' : baseline.toFixed(2)})`
          : `Planetary Computer, no BOA offset (baseline ${baseline!.toFixed(2)} < 04.00)`,
        nodata: 0,
      }
    }
  }

  const declared = declaredBandTransform(item, assetKey)
  if (declared) return declared

  if (opts.fallback) {
    return {
      scale: opts.fallback.scale,
      offset: opts.fallback.offset,
      source: 'sensor-default',
      note: opts.fallback.note ?? 'sensor default DN->reflectance transform',
      nodata: null,
    }
  }

  return identityTransform(
    `no scale/offset resolvable for asset "${assetKey}" — DN used unconverted`,
  )
}

/** Format a transform compactly, e.g. `x0.0001-0.1`. */
function formatTransform(t: ReflectanceTransform): string {
  const off = t.offset ? `${t.offset > 0 ? '+' : ''}${t.offset}` : ''
  return `x${t.scale}${off}`
}

/**
 * Resolve one transform per band of a band set.
 *
 * An index mixing bands on different scales is not something any supported formula
 * expects, so a disagreement is worth surfacing rather than silently picking one.
 */
export function resolveBandSetReflectance(
  item: any,
  assetKeys: string[],
  opts: ResolveOptions = {},
): { transforms: ReflectanceTransform[]; uniform: boolean; note: string } {
  const transforms = assetKeys.map((k) => resolveReflectance(item, k, opts))
  const first = transforms[0]
  const uniform = transforms.every((t) => t.scale === first.scale && t.offset === first.offset)
  const note = uniform
    ? `DN->reflectance ${formatTransform(first)} (${first.note})`
    : `bands declare differing DN->reflectance transforms (${transforms
        .map((t, i) => `${assetKeys[i]}: ${formatTransform(t)}`)
        .join(', ')}) — each applied to its own band`
  return { transforms, uniform, note }
}

/**
 * Mathematical bounds for an index, used to drop numerically degenerate pixels.
 *
 * A normalised difference is bounded to [-1, 1] by construction, so a value outside
 * that is not a surprising measurement — it is arithmetic on a denominator near zero,
 * or a transform applied that should not have been. Either way it is not reportable.
 *
 * EVI and SAVI carry gain factors (2.5 and 1.5) and legitimately exceed 1.
 */
export function indexBounds(index: string): [number, number] {
  switch (String(index || '').toUpperCase()) {
    case 'EVI':
      return [-1, 2.5]
    case 'SAVI':
      return [-1.5, 1.5]
    default:
      return [-1, 1]
  }
}

/**
 * Reject numerically degenerate index values.
 *
 * `Number.isFinite` is not enough. An additive offset puts real reflectance near zero,
 * so `(a-b)/(a+b)` can be evaluated with a denominator of ~0 on ordinary dark pixels and
 * return an enormous FINITE value — the mechanism behind the -1.09e11 NDVI that got the
 * first attempt at this fix reverted. A bounds check catches both that and the subtler
 * failure it replaced: NDVI of 1.77, which is finite, modest-looking, and impossible.
 */
export function isPlausibleIndexValue(v: number, index?: string): boolean {
  if (!Number.isFinite(v)) return false
  const [lo, hi] = indexBounds(index ?? '')
  return v >= lo && v <= hi
}

/**
 * Physical sanity check on a resolved transform, run against the pixels themselves.
 *
 * Surface reflectance below zero is possible — atmospheric correction over dark targets
 * genuinely over-corrects, which is *why* the BOA offset exists — but it is rare. When
 * a large share of clear pixels goes negative, the far likelier explanation is that an
 * offset was subtracted that was never there.
 *
 * This is the guard that would have caught this module's own first version, which
 * trusted earth-search's declared metadata and drove every rainforest red pixel to
 * -0.05. Metadata is a claim; pixels are evidence.
 *
 * `fraction` is the share of sampled values below `-0.02` (a tolerance that admits
 * genuine over-correction without admitting a whole missing offset).
 */
export function looksOverCorrected(fraction: number): boolean {
  return fraction > 0.25
}

export interface BuildIndexValuesOptions {
  /** Band-major pixel buffer as returned by titiler: [band0 …, band1 …, …]. */
  raw: Float64Array | ArrayLike<number>
  /** Pixels per band. */
  px: number
  /** How many leading bands are index inputs (the rest are quality/validity). */
  nBands: number
  /** One transform per input band, in the same order. */
  transforms: ReflectanceTransform[]
  /** Index name, for its mathematical bounds. */
  index: string
  /** Compiled formula over the transformed band values. */
  evaluate: (bands: Float64Array) => number
  /** Which pixels to consider at all (validity mask AND cloud mask). */
  include: (i: number) => boolean
  /** Provenance prefix describing the transform that was resolved. */
  baseNote: string
  /** Override the plausibility bounds (custom band expressions have no catalogued index). */
  bounds?: [number, number]
}

export interface BuildIndexValuesResult {
  /** Per-pixel index values; NaN wherever no value could be stood behind. */
  values: Float64Array
  /** Pixels that produced a usable value. */
  validCount: number
  /** Share of considered pixels whose reflectance went negative on the first pass. */
  negativeFraction: number
  /** True when the offset was withdrawn because the pixels contradicted it. */
  retriedWithoutOffset: boolean
  /** Provenance, including the retry if one happened. */
  note: string
}

/**
 * Convert DN to reflectance, evaluate the index, and refuse to report values the
 * arithmetic cannot support.
 *
 * Shared by all three index paths (`index-stats`, `analysis/grid-source`,
 * `analysis/sensors`) so the transform, the nodata rule, the bounds check and the
 * over-correction retry cannot drift apart between them.
 *
 * The retry is the important part. If the resolved transform drives a quarter of the
 * considered pixels to negative reflectance, the offset it subtracted was almost
 * certainly not in the data; the whole grid is recomputed without it and the note says
 * so. That turns a silent factor-of-two error into a visible, self-describing one.
 */
export function buildIndexValues(opts: BuildIndexValuesOptions): BuildIndexValuesResult {
  const { raw, px, nBands, index, evaluate, include, baseNote } = opts

  const run = (transforms: ReflectanceTransform[]) => {
    const values = new Float64Array(px).fill(NaN)
    const bandBuf = new Float64Array(nBands)
    let validCount = 0
    let considered = 0
    let negative = 0

    for (let i = 0; i < px; i++) {
      if (!include(i)) continue
      considered++
      let skip = false
      let sawNegative = false
      for (let b = 0; b < nBands; b++) {
        const dn = raw[b * px + i]
        const t = transforms[b]
        if (t.nodata != null && dn === t.nodata) { skip = true; break }
        const r = dn * t.scale + t.offset
        if (r < -0.02) sawNegative = true
        bandBuf[b] = r
      }
      if (skip) continue
      if (sawNegative) negative++
      const v = evaluate(bandBuf)
      if (opts.bounds ? !(Number.isFinite(v) && v >= opts.bounds[0] && v <= opts.bounds[1]) : !isPlausibleIndexValue(v, index)) continue
      values[i] = v
      validCount++
    }

    return {
      values,
      validCount,
      negativeFraction: considered > 0 ? negative / considered : 0,
    }
  }

  const first = run(opts.transforms)
  const hadOffset = opts.transforms.some((t) => t.offset !== 0)

  if (hadOffset && looksOverCorrected(first.negativeFraction)) {
    const withoutOffset = opts.transforms.map((t) => ({ ...t, offset: 0 }))
    const second = run(withoutOffset)
    return {
      ...second,
      negativeFraction: first.negativeFraction,
      retriedWithoutOffset: true,
      note:
        `${baseNote}; OFFSET WITHDRAWN — applying it drove ` +
        `${(first.negativeFraction * 100).toFixed(0)}% of clear pixels to negative reflectance, ` +
        `which is physically impossible, so the DN were treated as already offset-corrected`,
    }
  }

  return { ...first, retriedWithoutOffset: false, note: baseNote }
}

/** Wrap each `bN` of a positional formula as `(bN*scale+offset)` so titiler evaluates it
 *  on reflectance. `transforms[i]` belongs to band `i+1`. */
export function scaleExpression(positional: string, transforms: ReflectanceTransform[]): string {
  return positional.replace(/b(\d+)/g, (_m, n) => {
    const t = transforms[Number(n) - 1]
    if (!t) return `b${n}`
    const off = t.offset ? `+(${fixed(t.offset)})` : ''
    return `(b${n}*${fixed(t.scale)}${off})`
  })
}

/** Plain decimal (never exponent notation, which numexpr would still accept but is noisy). */
function fixed(x: number): string {
  return x.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
}
