/** Q-15: time from sending the request to the first `layer` SSE event, through the real HTTP route.
 *
 *    PORT=3160 AGENT_ALLOW_STUB=1 NODE_USE_ENV_PROXY=1 node .next/standalone/server.js &
 *    node scripts/perf/first-layer.mjs [--base=http://127.0.0.1:3160] [--tool=fetch_ndvi]
 *      [--aoi=kasur,lahore,beauce] [--runs=2]
 *
 *  The stub LLM runs exactly the requested tool (`stub-run:`), so no model round-trip is in the
 *  number: it is the tool path plus SSE only. Each AOI is run `--runs` times; the first run of an
 *  AOI is cold for the app's cache, later ones are warm. Per run it prints the first `layer`
 *  event (provisional or final), the first FINAL layer, and `done`, in seconds, plus the tool's own
 *  `timings` from the completed tool_call.
 */

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const base = arg('base', 'http://127.0.0.1:3160')
const tool = arg('tool', 'fetch_ndvi')
const runs = Number(arg('runs', '2'))
const AOIS = {
  kasur: [74.05, 31.12, 74.08, 31.15],
  lahore: [74.2, 31.28, 74.23, 31.31],
  beauce: [1.8, 48.3, 1.83, 48.33],
  iowa: [-93.7, 42.0, -93.67, 42.03],
  kitale: [34.98, 1.0, 35.01, 1.03],
}
const ids = arg('aoi', 'kasur,lahore,beauce').split(',')
const poly = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })

async function once(id) {
  const t0 = performance.now()
  const res = await fetch(`${base}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aoi: poly(AOIS[id]), query: `stub-run: [{"tool":"${tool}","args":{}}]`, lang: 'en', aiProvider: 'stub', aiModel: 'stub' }),
  })
  const out = { id, firstLayer: null, firstProvisional: null, firstFinal: null, done: null, toolMs: null, timings: null, layerEvents: 0, status: res.status }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const f of frames) {
      const ev = /^event: (.*)$/m.exec(f)?.[1]
      const data = /^data: (.*)$/m.exec(f)?.[1]
      if (!ev || !data) continue
      const t = (performance.now() - t0) / 1000
      const d = JSON.parse(data)
      if (ev === 'layer') {
        out.layerEvents++
        out.firstLayer ??= t
        if (d.provisional) out.firstProvisional ??= t
        else out.firstFinal ??= t
      } else if (ev === 'tool_call' && d.status === 'completed') {
        out.timings = d.timings
        out.toolMs = d.timings?.total ?? null
      } else if (ev === 'done') out.done = t
    }
  }
  return out
}

const f = (x) => (x == null ? '   -  ' : x.toFixed(2).padStart(6))
console.log(`${tool} via ${base}  (seconds from request start; stub LLM, so no model round-trip)`)
console.log('aoi      run  first-layer  provisional  final-layer   done   layer-events  stages(ms)')
for (const id of ids) {
  for (let r = 0; r < runs; r++) {
    const o = await once(id)
    const stages = o.timings ? Object.entries(o.timings).filter(([k]) => k !== 'llm_plan').map(([k, v]) => `${k}=${v}`).join(' ') : ''
    console.log(`${id.padEnd(8)} ${r === 0 ? 'cold' : 'warm'}  ${f(o.firstLayer)}      ${f(o.firstProvisional)}      ${f(o.firstFinal)}   ${f(o.done)}   ${o.layerEvents}            ${stages}`)
  }
}
