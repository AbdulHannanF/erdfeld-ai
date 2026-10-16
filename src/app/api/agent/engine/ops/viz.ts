/** Operations that draw or restyle what other operations already produced. */

import { z } from 'zod'

import { makeChart, styleLayer } from '../../tools/viz'
import { fail } from '../validate'
import { defineOperation, type AnyOperation } from '../operation'

const EARTH_AREA_KM2 = 510_072_000

export const vizOps: AnyOperation[] = [
  defineOperation({
    name: 'make_chart',
    label: 'Building chart...',
    version: '1.0.0',
    description: 'Draw ANY chart (time series, histogram, scatter, bar, spectral profile, correlation matrix, small multiples) as a Vega-Lite spec over data from this session\'s tool results. Reference data BY NAME, never type values: {"data": {"name": "<result_id>#<summary_key>"}} for a figure listed in a [citation_id: …] hint (arrays become rows {label, value[, date]}), or {"data": {"name": "<result_id>#features"}} for the feature properties of that result\'s layer (one row per feature, plus `_fid`). Inline `data.values`, `url` and `datasets` are rejected. Unknown names return an error listing the available ones.',
    params: z.object({
      spec: z.string().describe('Vega-Lite spec as a JSON-encoded string: mark, encoding, transform, layer… with `data` given only as {"name": "<result_id>#<key>"}.'),
      title: z.string().optional().describe('Short chart title.'),
      result_id: z.string().optional().describe('The existing result to chart (the toolbox picks one). Its figures and layer features become the names "<result_id>#<key>" the spec can use. In an agent run the spec names results directly and this is not needed.'),
    }),
    inputResult: { description: 'The result whose figures or features the chart draws.' },
    // Reads results that already exist, not the AOI: its size is no reason to refuse (the whole Earth's area).
    limits: { maxAreaKm2: EARTH_AREA_KM2 },
    output: 'chart',
    cost: { typicalSeconds: 1 },
    // Not cached: reads this request's own results, not only its arguments.
    limitations: [
      'Charts only data this request\'s own tool results produced, referenced by name; inline values, urls and datasets are rejected.',
      'It draws what the figures say; it does not add analysis.',
    ],
    confidence: 'not applicable: a chart repeats the cited figures and carries the confidence of the results it draws.',
    run: (ctx, args) => makeChart(ctx, args),
  }),
  defineOperation({
    name: 'style_layer',
    label: 'Styling layer by attribute...',
    version: '1.0.0',
    description: 'Colour an EXISTING vector layer\'s features by one of their properties (data-driven styling) and show a legend: "colour each field by median NDVI", "colour buildings by type". Pass `layer_id` (from a [layer_id: …] hint or the Layer Manifest) or `result_id`, and `property`. Numeric property -> graduated classes computed from the data; text property -> categorical. An unknown property returns an error listing the real ones. Does not fetch or compute anything.',
    params: z.object({
      layer_id: z.string().optional().describe('Id of the layer to restyle.'),
      result_id: z.string().optional().describe('The result_id whose vector layer to restyle (the toolbox picks one; a queued run needs it). Alternative to layer_id inside an agent run.'),
      property: z.string().describe('Feature property to colour by (must exist on the features).'),
      kind: z.enum(['graduated', 'categorical']).optional().describe('Default: graduated for numeric properties, categorical for text.'),
      colormap: z.string().optional().describe('Ramp: viridis (default), magma, inferno, plasma, cividis, greys, rdylgn, rdbu, spectral, terrain, blues, ylgn (append _r to reverse).'),
      method: z.enum(['quantile', 'equal']).optional().describe('Graduated class breaks: quantile (default) or equal interval.'),
      num_classes: z.number().optional().describe('Graduated class count, 2-9 (default 5).'),
      classes: z.array(z.object({
        value: z.string(),
        label: z.string().optional(),
        color: z.string().describe('CSS colour, e.g. #2e7d32'),
      })).optional().describe('Categorical only: explicit value -> colour mapping.'),
    }),
    inputResult: { description: 'The result whose vector layer is coloured.' },
    // Reads results that already exist, not the AOI: its size is no reason to refuse (the whole Earth's area).
    limits: { maxAreaKm2: EARTH_AREA_KM2 },
    output: 'vector',
    cost: { typicalSeconds: 1 },
    // Not cached: reads this request's own results, not only its arguments.
    limitations: [
      'Restyles an existing vector layer; it fetches and computes nothing.',
      'Graduated classes are computed from the layer\'s own values; an unknown property is refused with the real ones listed.',
    ],
    confidence: 'not applicable: styling does not change the data; the layer keeps the confidence of the result that made it.',
    staticChecks: (_ctx, args) =>
      args.layer_id || args.result_id
        ? []
        : [fail('static', 'layer_ref', 'style_layer needs `layer_id` or `result_id` (see the [layer_id: …] hints and the Layer Manifest).')],
    run: (ctx, args) => styleLayer(ctx, args),
  }),
]
