/**
 * Prints the operation table of docs/03-agent-tools-and-data.md from the live registry, so the
 * table is generated from code and cannot drift from it.
 *
 *   npx vite-node -c vitest.config.ts scripts/docs/ops-table.mts [--json]
 *   npx vite-node -c vitest.config.ts scripts/docs/ops-table.mts --write docs/03-agent-tools-and-data.md
 *
 * `--write <file>` replaces the text between the markers `<!-- ops-table:start -->` and
 * `<!-- ops-table:end -->` in that file; without it the table goes to stdout.
 *
 * (`tsx` cannot load the engine: it needs the `@/` alias, which vitest.config.ts supplies.)
 *
 * It reads `registryJson()` (what `GET /api/operations` returns) for the contract, `listOperations()`
 * for `cacheTtl` and for operations the model is not offered, and finds each operation's
 * "enabled when" by turning the env flags that gate operations on in every combination and
 * recording the smallest set under which the operation is registered. Nothing is hard-coded
 * per operation.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { EXCESSIVE_AOI_KM2 } from '../../src/lib/aoi-guard'
import { listOperations, registryJson } from '../../src/app/api/agent/engine/registry'

const FLAGS: Array<{ env: string; value: string }> = [
  { env: 'GEO_SERVICE_URL', value: 'http://127.0.0.1:8100' },
  { env: 'GEO_TIMESFM_FORECAST', value: '1' },
  { env: 'GEOAGENT_ENABLE_CV', value: '1' },
  { env: 'AGENT_ALLOW_STUB', value: '1' },
]

const saved = Object.fromEntries(FLAGS.map((f) => [f.env, process.env[f.env]]))
function withFlags<T>(on: string[], fn: () => T): T {
  for (const f of FLAGS) delete process.env[f.env]
  for (const f of FLAGS) if (on.includes(f.env)) process.env[f.env] = f.value
  try { return fn() } finally {
    for (const f of FLAGS) {
      if (saved[f.env] === undefined) delete process.env[f.env]
      else process.env[f.env] = saved[f.env]
    }
  }
}

function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = []
  for (let mask = 0; mask < 1 << xs.length; mask++) out.push(xs.filter((_, i) => mask & (1 << i)))
  return out.sort((a, b) => a.length - b.length)
}

const all = FLAGS.map((f) => f.env)
const combos = subsets(all).map((on) => ({ on, names: new Set(withFlags(on, () => listOperations().map((o) => o.name))) }))

function enabledWhen(name: string): string {
  const hit = combos.find((c) => c.names.has(name))
  if (!hit) return 'never (not registered under any flag)'
  return hit.on.length === 0 ? 'always' : hit.on.map((e) => (e === 'GEO_SERVICE_URL' ? 'GEO_SERVICE_URL set' : `${e}=1`)).join(' and ')
}

const ms = (v: number) => (v >= 86_400_000 ? `${v / 86_400_000} d` : v >= 3_600_000 ? `${v / 3_600_000} h` : `${v / 60_000} min`)
const ttl = (t?: { liveMs: number; settledMs?: number }) =>
  !t ? 'not cached' : `${t.liveMs > 0 ? ms(t.liveMs) : 'not cached'} live${t.settledMs ? `, ${ms(t.settledMs)} settled` : ''}`
const rows = withFlags(all, () => {
  const contract = new Map(registryJson().map((o) => [o.name, o]))
  return listOperations().map((op) => {
    const c = contract.get(op.name)
    const lim = c?.limits ?? { maxAreaKm2: op.limits?.maxAreaKm2 ?? EXCESSIVE_AOI_KM2, minAreaKm2: op.limits?.minAreaKm2 ?? null, earliest: op.limits?.earliest ?? null, needsDates: !!op.limits?.needsDates }
    return {
      name: op.name,
      version: op.version,
      output: op.output,
      sensors: op.sensors ?? [],
      resolution_m: op.resolution_m ?? null,
      limits: lim,
      cost_s: op.cost.typicalSeconds,
      cacheTtl: op.cacheTtl,
      modelFacing: op.modelFacing !== false,
      description: op.description,
      enabledWhen: enabledWhen(op.name),
    }
  })
})

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const limits = (l: (typeof rows)[number]['limits']) =>
    [`max ${l.maxAreaKm2} km2`, l.minAreaKm2 != null ? `min ${l.minAreaKm2} km2` : '', l.earliest ? `from ${l.earliest}` : '', l.needsDates ? 'needs dates' : ''].filter(Boolean).join('; ')
  const table = [
    '| Operation | Version | Output | Sensors / data | Resolution | Limits | Typical s | Cache TTL | Enabled when |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      `| \`${r.name}\`${r.modelFacing ? '' : ' (not offered to the model)'} | ${r.version} | ${r.output} | ${r.sensors.join(', ') || 'n/a'} | ${r.resolution_m != null ? `${r.resolution_m} m` : 'n/a'} | ${limits(r.limits)} | ${r.cost_s} | ${ttl(r.cacheTtl)} | ${r.enabledWhen} |`),
    '',
    `${rows.length} operations registered with every flag on; ${rows.filter((r) => r.enabledWhen === 'always').length} are registered with no flag set.`,
  ].join('\n')
  const target = process.argv.includes('--write') ? process.argv[process.argv.indexOf('--write') + 1] : undefined
  if (!target) {
    console.log(table)
  } else {
    const text = readFileSync(target, 'utf8')
    const start = '<!-- ops-table:start -->'
    const end = '<!-- ops-table:end -->'
    const a = text.indexOf(start)
    const b = text.indexOf(end)
    if (a < 0 || b < a) throw new Error(`${target} has no ${start} ... ${end} block`)
    writeFileSync(target, `${text.slice(0, a + start.length)}\n${table}\n${text.slice(b)}`)
    console.log(`wrote ${rows.length} rows to ${target}`)
  }
}
