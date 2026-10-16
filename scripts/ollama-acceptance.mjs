// Live acceptance harness: drives the real /api/agent SSE route with the
// provided Ollama provider, capturing the full event sequence. Run with:
//   node scripts/ollama-acceptance.mjs <step> [model]
// where <step> is: elevation | describe | flood | point
const BASE = process.env.GEO_BASE || 'http://localhost:3000'
const OLLAMA = process.env.OLLAMA_BASE || 'http://100.70.127.42:11434'
const MODEL = process.argv[3] || 'gpt-oss:20b'
const STEP = process.argv[2] || 'elevation'

// Central Nairobi polygon (CBD), ~ matches the walkthrough script's AOI.
const aoi = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [36.8100, -1.2950],
      [36.8330, -1.2950],
      [36.8330, -1.2720],
      [36.8100, -1.2720],
      [36.8100, -1.2950],
    ]],
  },
}

const QUERIES = {
  elevation: { query: 'What is the elevation of this area?' },
  describe:  { query: 'Give me a one-paragraph description of this place.' },
  flood:     { query: "What's the flood risk here?" },
  precip:    { query: 'Is this area getting drier? Show me the rainfall history and any recent precipitation anomalies.' },
  build:     { query: 'Is this a good place to build a new housing estate? Assess the terrain steepness, flood/surface-water risk, soil suitability, and how built-up the surroundings already are.' },
  point:     { query: 'What is this?', focus: { lat: -1.2864, lng: 36.8172, kind: 'point' } },
}

const sel = QUERIES[STEP]
if (!sel) { console.error('unknown step', STEP); process.exit(1) }

const payload = {
  aoi: aoi.geometry,
  query: sel.query,
  focus: sel.focus,
  lang: 'en',
  aiProvider: 'ollama',
  aiBaseUrl: OLLAMA,
  aiModel: MODEL,
}

const t0 = Date.now()
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
console.log(`=== STEP=${STEP} MODEL=${MODEL} ===`)
console.log(`query: "${sel.query}"${sel.focus ? ' (focus point)' : ''}`)

const events = []
let tokenBuf = ''

const res = await fetch(`${BASE}/api/agent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(Number(process.env.TIMEOUT_MS || 300000)),
})
console.log(stamp(), 'HTTP', res.status, res.headers.get('content-type'))

const reader = res.body.getReader()
const dec = new TextDecoder()
let buffer = ''
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += dec.decode(value, { stream: true })
  const blocks = buffer.split('\n\n')
  buffer = blocks.pop() || ''
  for (const block of blocks) {
    let ev = '', data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) ev = line.slice(7).trim()
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (!ev) continue
    let d = {}
    try { d = JSON.parse(data) } catch {}
    if (ev === 'token') { tokenBuf += d.content || ''; continue }
    events.push(ev)
    if (ev === 'plan') {
      console.log(stamp(), `PLAN [${d.kind}]:`, (d.steps || []).map((s, i) => `${i}:${s.tool}`).join(' '))
    } else if (ev === 'tool_call') {
      console.log(stamp(), `tool_call ${d.status.padEnd(9)} ${d.tool_name}${d.result_summary ? ' — ' + d.result_summary.slice(0, 80) : ''}`)
    } else if (ev === 'layer') {
      console.log(stamp(), `LAYER ${d.layer_id} (${d.layer_type}) conf=${d.confidence?.level || '?'} prov=${d.provenance?.source || '?'}`)
    } else if (ev === 'error') {
      console.log(stamp(), `ERROR:`, d.content)
    } else if (ev === 'manifest' || ev === 'zoom_to' || ev === 'weather' || ev === 'air_quality') {
      // low-signal, count only
    } else {
      console.log(stamp(), ev)
    }
  }
}

console.log('\n--- ANALYSIS TEXT (' + tokenBuf.length + ' chars) ---')
console.log(tokenBuf.slice(0, 4000))
console.log('\n--- EVENT TALLY ---')
const tally = {}
for (const e of events) tally[e] = (tally[e] || 0) + 1
console.log(tally, '| total', stamp())
