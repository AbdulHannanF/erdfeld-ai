/** One real Ask run through the route, printing the provider-reported token totals from the `done` event.
 *    NODE_USE_ENV_PROXY=1 npx vite-node --config vitest.config.ts scripts/perf/ask-tokens.mts "Show me NDVI for this area." [provider] [model]
 *  Uses GEMINI_API_KEY from .env (never printed). For a local model: provider `ollama`, model e.g. gemma4:26b-a4b-it-qat,
 *  with GEOAGENT_LLM_TIMEOUT_MS raised and the base URL in OLLAMA_URL. */
import '../../eval/planner/env'
import { NextRequest } from 'next/server'
import { POST } from '../../src/app/api/agent/route'

const query = process.argv[2] ?? 'Show me NDVI for this area.'
const provider = process.argv[3] ?? 'gemini'
const model = process.argv[4]
const AOI = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }
const body: any = { aoi: AOI, query, lang: 'en', aiProvider: provider }
if (model) body.aiModel = model
if (provider === 'ollama') body.aiBaseUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const res = await POST(new NextRequest('http://localhost/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ''
const names: string[] = []
let done: any = null
let answer = ''
const t0 = Date.now()
for (;;) {
  const { done: end, value } = await reader.read()
  if (end) break
  buf += dec.decode(value, { stream: true })
  const frames = buf.split('\n\n')
  buf = frames.pop() ?? ''
  for (const f of frames) {
    const ev = /^event: (.+)$/m.exec(f)?.[1]
    const data = /^data: (.+)$/m.exec(f)?.[1]
    if (!ev) continue
    names.push(ev)
    if (ev === 'done' && data) done = JSON.parse(data)
    if (ev === 'token' && data) answer += JSON.parse(data).content ?? ''
    if (ev === 'error' && data) console.log('ERROR', data.slice(0, 300))
  }
}
console.log(`query: ${query}`)
console.log(`events: ${[...new Set(names)].join(', ')} | ${((Date.now() - t0) / 1000).toFixed(0)} s | answer ${answer.length} chars`)
console.log('tools offered:', done?.tools_offered)
console.log('tokens:', JSON.stringify(done?.tokens))
process.exit(0)
