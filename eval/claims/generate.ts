/** Build the labelled plot set for the claim evaluation from Hansen GFC-2024-v1.12.
 *
 *    NODE_USE_ENV_PROXY=1 npx tsx eval/claims/generate.ts [--per-class 25] [--seed 7] [--out eval/claims/plots.json]
 *
 *  A plot is a 300 m square (10 x 10 Hansen pixels) in one of the BIOMES. Labels:
 *    loss    >= 60% of the plot's pixels lost tree cover in 2021-2023, none in any other year,
 *            and the 2000 canopy was >= 50% on average (so the claim "not cleared since 2020" is false);
 *    stable  no loss pixel in any year 2001-2024 and a 2000 canopy >= 70% everywhere
 *            (so the claim "not cleared since 2020" is true).
 *  Hansen "loss" is stand-replacing tree-cover loss from any cause (clearing, harvest, fire), the
 *  label is therefore "tree cover lost", which is what a "not cleared" claim is about.
 *  The list is interleaved across biomes and classes so any prefix is balanced.
 */

import { writeFileSync } from 'node:fs'

import { BIOMES, type Biome } from './biomes'
import { PX_DEG, readWindow, tileName, type HansenWindow } from './hansen'

export interface LabelledPlot {
  seq: number
  id: string
  biome: string
  label: 'loss' | 'stable'
  lon: number
  lat: number
  geometry: GeoJSON.Polygon
  /** Share of the plot's pixels with loss in 2021-2023 (loss) or 0 (stable). */
  loss_frac: number
  mean_treecover2000: number
  split: 'dev' | 'test'
}

const BLOCK = 10
const WINDOW = 400

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Candidate { label: 'loss' | 'stable'; lon: number; lat: number; loss_frac: number; tc: number; geometry: GeoJSON.Polygon }

function candidatesIn(win: HansenWindow, rand: () => number): Candidate[] {
  const out: Candidate[] = []
  const n = win.size
  for (let r0 = 0; r0 + BLOCK <= n; r0 += BLOCK) {
    for (let c0 = 0; c0 + BLOCK <= n; c0 += BLOCK) {
      let lossIn = 0, other = 0, any = 0, tcSum = 0, tcMin = 255
      for (let r = r0; r < r0 + BLOCK; r++) {
        for (let c = c0; c < c0 + BLOCK; c++) {
          const i = r * n + c
          const y = win.lossyear[i]
          const tc = win.treecover[i]
          tcSum += tc
          if (tc < tcMin) tcMin = tc
          if (y > 0) any++
          if (y >= 21 && y <= 23) lossIn++
          else if (y > 0) other++
        }
      }
      const px = BLOCK * BLOCK
      const tc = tcSum / px
      // The array's first row is the northern edge.
      const west = win.west + c0 * PX_DEG
      const north = win.south + (n - r0) * PX_DEG
      const geometry: GeoJSON.Polygon = {
        type: 'Polygon',
        coordinates: [[[west, north], [west + BLOCK * PX_DEG, north], [west + BLOCK * PX_DEG, north - BLOCK * PX_DEG], [west, north - BLOCK * PX_DEG], [west, north]]],
      }
      const lon = west + (BLOCK * PX_DEG) / 2
      const lat = north - (BLOCK * PX_DEG) / 2
      if (lossIn / px >= 0.6 && other === 0 && tc >= 50) out.push({ label: 'loss', lon, lat, loss_frac: lossIn / px, tc, geometry })
      else if (any === 0 && tcMin >= 40 && tc >= 70) out.push({ label: 'stable', lon, lat, loss_frac: 0, tc, geometry })
    }
  }
  // A few per window, spread out by shuffling.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

async function sampleBiome(b: Biome, perClass: number, rand: () => number): Promise<Record<'loss' | 'stable', Candidate[]>> {
  const got: Record<'loss' | 'stable', Candidate[]> = { loss: [], stable: [] }
  const [w, s, e, n] = b.box
  const span = WINDOW * PX_DEG
  let tries = 0
  while ((got.loss.length < perClass || got.stable.length < perClass) && tries < 400) {
    tries++
    const lon = w + rand() * (e - w - span)
    const lat = s + rand() * (n - s - span)
    if (tileName(lat, lon) !== tileName(lat + span, lon + span)) continue
    let win: HansenWindow
    try {
      win = await readWindow(lat, lon, WINDOW)
    } catch (err) {
      console.error(`  ${b.id}: window skipped (${(err as Error).message})`)
      continue
    }
    const cands = candidatesIn(win, rand)
    for (const kind of ['loss', 'stable'] as const) {
      if (got[kind].length >= perClass) continue
      // At most 3 per window and class, and not on top of one another.
      for (const c of cands.filter((x) => x.label === kind).slice(0, 3)) {
        if (got[kind].length < perClass) got[kind].push(c)
      }
    }
    process.stderr.write(`  ${b.id}: ${got.loss.length} loss, ${got.stable.length} stable after ${tries} windows\r`)
  }
  process.stderr.write('\n')
  return got
}

async function main() {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d }
  const perClass = Number(arg('--per-class', '25'))
  const seed = Number(arg('--seed', '7'))
  const out = arg('--out', 'eval/claims/plots.json')
  const rand = rng(seed)
  const per: Record<string, Record<'loss' | 'stable', Candidate[]>> = {}
  for (const b of BIOMES) {
    console.error(`${b.id}: sampling ${perClass} loss + ${perClass} stable plots`)
    per[b.id] = await sampleBiome(b, perClass, rand)
  }
  const plots: LabelledPlot[] = []
  for (let k = 0; k < perClass; k++) {
    for (const kind of ['loss', 'stable'] as const) {
      for (const b of BIOMES) {
        const c = per[b.id][kind][k]
        if (!c) continue
        const seq = plots.length
        plots.push({
          seq, id: `${b.id}-${kind}-${String(k + 1).padStart(2, '0')}`, biome: b.id, label: kind,
          lon: Number(c.lon.toFixed(5)), lat: Number(c.lat.toFixed(5)), geometry: c.geometry,
          loss_frac: Number(c.loss_frac.toFixed(2)), mean_treecover2000: Number(c.tc.toFixed(0)), split: 'test',
        })
      }
    }
  }
  // The first 20 are the development set (the recipe's thresholds were set on these only).
  plots.slice(0, 20).forEach((p) => { p.split = 'dev' })
  writeFileSync(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: 'Hansen GFC-2024-v1.12 (lossyear, treecover2000)', seed, plots }, null, 1))
  const counts = BIOMES.map((b) => `${b.id} ${plots.filter((p) => p.biome === b.id && p.label === 'loss').length}/${plots.filter((p) => p.biome === b.id && p.label === 'stable').length}`)
  console.error(`wrote ${plots.length} plots to ${out} (loss/stable per biome: ${counts.join(', ')})`)
}

if (process.argv[1]?.endsWith('generate.ts')) main()
