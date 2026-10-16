/** Confirm the AOI size guard actually fires against the running app. */
import { runAgentQuery } from './sse-client.mjs'

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })

const CASES = [
  { name: 'excessive (~world)', aoi: box(-120, -40, 120, 40), expect: 'refuse' },
  { name: 'large (~2500 km²)', aoi: box(73.0, 31.0, 73.5, 31.4), expect: 'warn' },
  { name: 'ok (~38 km²)', aoi: box(73.05, 31.40, 73.11, 31.46), expect: 'normal' },
]

for (const c of CASES) {
  const r = await runAgentQuery({ aoi: c.aoi, query: 'What is the average NDVI here?', timeoutMs: 120_000 })
  const head = (r.answer || '').replace(/\s+/g, ' ').slice(0, 150)
  console.log(
    `${c.name.padEnd(20)} expect=${c.expect.padEnd(7)} http=${r.http} ` +
    `events=${JSON.stringify(r.events)} errors=${r.errors.length} tools=${r.tools.length}` +
    `${r.transport_error ? ` TRANSPORT=${r.transport_error.slice(0, 90)}` : ''}`,
  )
  if (r.errors.length) console.log(`   error: ${String(r.errors[0]).slice(0, 160)}`)
  if (head) console.log(`   text : ${head}`)
  console.log()
}
