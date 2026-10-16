/** Which operations the planner is shown for a question.
 *
 *  Every planner-facing operation (about 45) was sent as a function declaration on every model turn:
 *  roughly 25 000 prompt tokens before the question. Most questions need two or three of them. This picks
 *  the relevant ones deterministically (no model call): a question's words are matched against each
 *  operation's name and description, rarer words counting for more, and operations scoring close to the best
 *  are offered. `submit_plan` always is.
 *
 *  It is a shortlist, not a gate: the executor still runs any registered operation a plan names, and the loop
 *  re-asks with the full set if the shortlisted turn produced no plan at all. Its recall is measured against the
 *  planner evaluation's expected operations (see the shortlist test). */

import { listOperations } from './registry'
import type { AnyOperation } from './operation'

const STOP = new Set(('the and for with this that these those from into over under what which when where how many much are was were has have had can could ' +
  'would should will you your our their its out off per any all each every more most less than then them they here there about between during after before ' +
  'show give tell find get make let use using used want need please map area areas region place data like also just only both such own same other').split(' '))

/** Words a user says that the operation descriptions say another way. */
const SYNONYMS: Record<string, string[]> = {
  flooded: ['flood'], flooding: ['flood'], inundation: ['flood'], inundated: ['flood'], submerged: ['flood'],
  burnt: ['burn', 'fire'], burned: ['burn', 'fire'], wildfire: ['fire', 'burn'], blaze: ['fire'],
  deforestation: ['forest', 'deforest'], logging: ['forest', 'deforest'], clearing: ['forest', 'deforest'],
  crops: ['crop', 'field', 'vegetation'], farmland: ['field', 'crop'], farm: ['field', 'crop'], harvest: ['crop', 'vegetation'],
  greenness: ['ndvi', 'vegetation'], green: ['ndvi', 'vegetation'], vegetation: ['ndvi'], plants: ['vegetation'], trees: ['forest', 'vegetation'],
  rain: ['precipitation', 'weather'], rainfall: ['precipitation', 'weather'], rainy: ['precipitation'], monsoon: ['precipitation', 'weather'], drought: ['precipitation', 'ndvi'],
  temperature: ['weather', 'thermal'], heat: ['thermal', 'weather', 'temperature'], hot: ['thermal', 'weather'], warm: ['thermal'], weather: ['weather'],
  elevation: ['dem', 'terrain'], altitude: ['dem', 'terrain'], hillshade: ['dem', 'terrain'], slope: ['slope', 'terrain', 'elevation'], terrain: ['dem'], mountain: ['dem', 'terrain'], steep: ['slope'], contour: ['elevation'],
  buildings: ['building', 'osm'], houses: ['building', 'osm'], roads: ['road', 'osm'], streets: ['road', 'osm'], rivers: ['osm', 'water'], lakes: ['water'], water: ['water', 'ndwi'],
  construction: ['change', 'building'], development: ['change', 'building'], changed: ['change'], changes: ['change'], compare: ['change'], versus: ['change'],
  cars: ['detect', 'object'], vehicles: ['detect', 'object'], ships: ['detect', 'object'], solar: ['detect', 'object'], panels: ['detect', 'object'],
  forecast: ['forecast', 'predict'], predict: ['forecast'], anomaly: ['anomaly'], unusual: ['anomaly'],
  radar: ['sar', 'sentinel'], sar: ['sar'], thermal: ['thermal'], landsat: ['landsat'], lidar: ['lidar'],
  dataset: ['dataset', 'find'], datasets: ['dataset', 'find'], catalogue: ['dataset'], open: ['dataset'],
  claim: ['claim', 'verify'], claims: ['claim', 'verify'], verify: ['claim'], plot: ['field', 'claim'], plots: ['field', 'claim'],
  chart: ['chart'], graph: ['chart'], histogram: ['chart'], plot_chart: ['chart'], style: ['style'], colour: ['style'], color: ['style'], legend: ['style'],
  median: ['composite'], cloudfree: ['composite'], cloud: ['composite'], mosaic: ['composite'], average: ['composite', 'mean'], season: ['composite', 'precipitation'],
  greener: ['anomaly', 'ndvi'], browner: ['anomaly', 'ndvi'], normal: ['anomaly'], usual: ['anomaly'], typical: ['anomaly'], expected: ['anomaly'],
  hospitals: ['osm'], schools: ['osm'], shops: ['osm'], mapped: ['osm'], clinics: ['osm'], parks: ['osm'], amenities: ['osm'], restaurants: ['osm'],
  population: ['population', 'worldpop'], people: ['population'], pollution: ['air'], air: ['air'],
  landcover: ['land', 'cover', 'worldcover'], land: ['land', 'cover'], urban: ['built', 'building'], builtup: ['built'], impervious: ['built'],
}

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, (m, _s, off) => (w.length - m.length >= 4 ? '' : m))
const tokens = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !STOP.has(t)).map(stem)

interface Indexed { op: AnyOperation; name: Set<string>; text: Set<string> }
let cache: { key: string; index: Indexed[]; idf: Map<string, number> } | null = null

function indexOperations(ops: AnyOperation[]) {
  const key = ops.map((o) => `${o.name}:${o.description.length}`).join('|')
  if (cache?.key === key) return cache
  const index: Indexed[] = ops.map((op) => ({
    op,
    name: new Set(tokens(op.name.replace(/_/g, ' '))),
    text: new Set(tokens(`${op.description} ${(op.sensors ?? []).join(' ')} ${op.output}`)),
  }))
  const df = new Map<string, number>()
  for (const i of index) for (const t of new Set([...i.name, ...i.text])) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + ops.length / n)]))
  cache = { key, index, idf }
  return cache
}

export interface Shortlist {
  /** Operation names offered, best first. */
  names: string[]
  /** Score per offered operation, for the log. */
  scores: Record<string, number>
}

/** How many operations at most, and how close to the best score an operation must be to be offered. */
export const SHORTLIST_MAX = 10
const CLOSE_TO_BEST = 0.45
const MIN_OPS = 6

/** The operations to offer for `question`. With no usable words (or no match at all) every operation is returned. */
export function shortlistOperations(question: string, ops: AnyOperation[] = listOperations().filter((o) => o.modelFacing !== false)): Shortlist {
  const { index, idf } = indexOperations(ops)
  const words = new Set<string>()
  for (const raw of question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (raw.length < 3 || STOP.has(raw)) continue
    words.add(stem(raw))
    for (const s of SYNONYMS[raw] ?? []) words.add(stem(s))
  }
  if (words.size === 0) return all(ops)
  const scored = index.map(({ op, name, text }) => {
    let score = 0
    for (const w of words) {
      const weight = idf.get(w) ?? 0
      if (name.has(w)) score += 3 * weight
      else if (text.has(w)) score += weight
    }
    return { name: op.name, score }
  }).sort((a, b) => b.score - a.score)
  const best = scored[0]?.score ?? 0
  if (best <= 0) return all(ops)
  const picked = scored.filter((s, i) => s.score >= CLOSE_TO_BEST * best || i < MIN_OPS).slice(0, SHORTLIST_MAX)
  return { names: picked.map((p) => p.name), scores: Object.fromEntries(picked.map((p) => [p.name, Number(p.score.toFixed(2))])) }
}

function all(ops: AnyOperation[]): Shortlist {
  return { names: ops.map((o) => o.name), scores: {} }
}
