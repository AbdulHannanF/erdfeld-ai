/** Vega-Lite chart contract + the small spec templates the client builds itself.
 *
 *  Shared by the server (`make_chart` returns `ChartItem`s) and the browser (VegaChart
 *  renders them). Pure: no DOM, no node APIs.
 *
 *  Two kinds of spec reach VegaChart: agent-authored ones, whose data the server inlined
 *  from real tool results (the model only ever references data by name), and the
 *  templates below, which the client builds from figures the store already holds.
 */

export interface ChartItem {
  id: string
  title: string
  /** A complete Vega-Lite spec (data already inlined as `data.values`). */
  spec: Record<string, any>
  /** When the rows came from a layer's features (`<result_id>#features`), that layer's
   *  id: marks carry `_fid` = the feature's index, which links chart and map. */
  layerId?: string
}

/** Row field holding the map feature id (index in the layer's FeatureCollection). */
export const FID_FIELD = '_fid'
/** Vega signal driven by the map selection. */
export const HIGHLIGHT_PARAM = 'hlFid'

export interface LabeledPoint { label: string; value: number }

const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?$/

/** True when every label is an ISO year-month or date, so the series is temporal. */
export function isDateSeries(points: LabeledPoint[]): boolean {
  return points.length > 1 && points.every((p) => DATE_LABEL.test(p.label))
}

// ---------------------------------------------------------------------------
// Templates (client-built from real figures)
// ---------------------------------------------------------------------------

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'

/** Bars for a labelled series (land-cover %, monthly rainfall, class counts). */
export function barSpec(points: LabeledPoint[], opts: { yTitle?: string; format?: string } = {}): Record<string, any> {
  return {
    $schema: SCHEMA,
    data: { values: points },
    mark: { type: 'bar', cornerRadiusEnd: 2 },
    encoding: {
      x: { field: 'label', type: 'nominal', sort: null, axis: { title: null, labelAngle: points.length > 6 ? -40 : 0 } },
      y: { field: 'value', type: 'quantitative', axis: { title: opts.yTitle ?? null, ...(opts.format ? { format: opts.format } : {}) } },
      tooltip: [{ field: 'label', title: 'Category' }, { field: 'value', type: 'quantitative', title: opts.yTitle ?? 'Value' }],
    },
  }
}

/** Line for a labelled series; dated labels become a temporal axis. */
export function lineSpec(points: LabeledPoint[], opts: { yTitle?: string; area?: boolean } = {}): Record<string, any> {
  const temporal = isDateSeries(points)
  return {
    $schema: SCHEMA,
    data: { values: points },
    mark: { type: opts.area ? 'area' : 'line', point: !opts.area, interpolate: 'monotone', ...(opts.area ? { line: true, opacity: 0.3 } : {}) },
    encoding: {
      x: temporal
        ? { field: 'label', type: 'temporal', axis: { title: null, format: '%b %d' } }
        : { field: 'label', type: 'ordinal', sort: null, axis: { title: null, labelOverlap: true } },
      y: { field: 'value', type: 'quantitative', scale: { zero: false }, axis: { title: opts.yTitle ?? null } },
      tooltip: [{ field: 'label', title: temporal ? 'Date' : 'Position' }, { field: 'value', type: 'quantitative', title: opts.yTitle ?? 'Value' }],
    },
  }
}

/** Histogram from pre-binned counts, with an optional modal-value rule. */
export function histogramSpec(bins: Array<{ bin: number; pixels: number }>, opts: { xTitle?: string; modal?: number | null } = {}): Record<string, any> {
  const bars = {
    mark: { type: 'bar', cornerRadiusEnd: 1 },
    encoding: {
      x: { field: 'bin', type: 'quantitative', axis: { title: opts.xTitle ?? null, format: '.2f' } },
      y: { field: 'pixels', type: 'quantitative', axis: { title: 'Clear pixels', format: '~s' } },
      tooltip: [{ field: 'bin', type: 'quantitative', title: 'Bin', format: '.3f' }, { field: 'pixels', type: 'quantitative', title: 'Pixels', format: ',' }],
    },
  }
  const base: Record<string, any> = { $schema: SCHEMA, data: { values: bins } }
  if (typeof opts.modal !== 'number') return { ...base, ...bars }
  return {
    ...base,
    layer: [
      bars,
      { data: { values: [{ modal: opts.modal }] }, mark: { type: 'rule', strokeDash: [4, 4] }, encoding: { x: { field: 'modal', type: 'quantitative' } } },
    ],
  }
}

/** The one chart path for array-valued figures: dated series draw as a line, the rest as bars. */
/** Experimental semivariogram: bins as points joined by a line, with the fitted sill and range
 *  drawn as dashed rules when the analysis reported them. `lag` is in metres. */
export function variogramSpec(
  bins: Array<{ lag: number; gamma: number }>,
  opts: { sill?: number | null; range?: number | null } = {},
): Record<string, any> {
  const layers: Record<string, any>[] = [
    {
      mark: { type: 'line', point: { size: 40 } },
      encoding: {
        x: { field: 'lag', type: 'quantitative', axis: { title: 'Lag (m)' } },
        y: { field: 'gamma', type: 'quantitative', axis: { title: 'Semivariance' } },
        tooltip: [{ field: 'lag', type: 'quantitative', title: 'Lag (m)' }, { field: 'gamma', type: 'quantitative', title: 'Semivariance', format: '.4' }],
      },
    },
  ]
  if (opts.sill != null) {
    layers.push({
      data: { values: [{ sill: opts.sill }] },
      mark: { type: 'rule', strokeDash: [4, 4] },
      encoding: { y: { field: 'sill', type: 'quantitative' }, tooltip: [{ field: 'sill', type: 'quantitative', title: 'Sill', format: '.4' }] },
    })
  }
  if (opts.range != null) {
    layers.push({
      data: { values: [{ range: opts.range }] },
      mark: { type: 'rule', strokeDash: [4, 4] },
      encoding: { x: { field: 'range', type: 'quantitative' }, tooltip: [{ field: 'range', type: 'quantitative', title: 'Range (m)' }] },
    })
  }
  return { $schema: SCHEMA, data: { values: bins }, layer: layers }
}

export function seriesSpec(points: LabeledPoint[]): Record<string, any> {
  return isDateSeries(points) ? lineSpec(points) : barSpec(points)
}

// ---------------------------------------------------------------------------
// Map <-> chart link
// ---------------------------------------------------------------------------

/** True when the spec's inline rows carry a feature id (`make_chart` over `#features`). */
export function specHasFid(spec: Record<string, any>): boolean {
  const rows = (spec?.data as any)?.values
  if (Array.isArray(rows)) return rows.length > 0 && FID_FIELD in rows[0]
  return JSON.stringify(spec).includes(`"${FID_FIELD}"`)
}

function dimUnselected(enc: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!enc || enc.opacity) return enc
  return {
    ...enc,
    opacity: {
      condition: { test: `${HIGHLIGHT_PARAM} === null || datum.${FID_FIELD} === ${HIGHLIGHT_PARAM}`, value: 1 },
      value: 0.25,
    },
  }
}

/** Add a `hlFid` variable param and dim every mark whose `_fid` is not the selected one (layers without
 *  encodings, e.g. reference rules, are left alone).
 *  Leaves the spec untouched when it has no encodings it can safely extend (concat /
 *  facet / repeat) — those still emit click selections, they just don't dim. */
export function withHighlight(spec: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...spec, params: [...(spec.params ?? []), { name: HIGHLIGHT_PARAM, value: null }] }
  if (Array.isArray(spec.layer)) next.layer = spec.layer.map((l: any) => (l.mark && l.encoding ? { ...l, encoding: dimUnselected(l.encoding) } : l))
  else if (spec.mark && spec.encoding) next.encoding = dimUnselected(spec.encoding)
  return next
}
