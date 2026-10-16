/**
 * Lightweight local stand-in for a self-hosted TiTiler, used to verify the
 * TITILER_ENDPOINT routing path end-to-end without Docker/GDAL.
 *
 * It listens on :8000 and forwards /cog/* and /stac/* to a real TiTiler. Pointing
 * the app's TITILER_ENDPOINT at http://localhost:8000 proves the app fetches tiles
 * from the configured endpoint (not the hardcoded public one), and that a tiler
 * reached via that endpoint returns real PNG tiles to the app's own URL builders.
 *
 *   node scripts/local-titiler-proxy.mjs
 *   RENDER_LIVE=1 TITILER_ENDPOINT=http://localhost:8000 npx vitest run render-live
 */
import http from 'node:http'

const TARGET = process.env.PROXY_TARGET || 'https://titiler.xyz'
const PORT = Number(process.env.PROXY_PORT || 8000)

const server = http.createServer(async (req, res) => {
  const upstream = TARGET + req.url
  try {
    const r = await fetch(upstream)
    const buf = Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' })
    res.end(buf)
    console.log(`[proxy] ${req.method} ${req.url.slice(0, 60)} → ${r.status} ${buf.length}B`)
  } catch (e) {
    res.writeHead(502)
    res.end('proxy error')
    console.log(`[proxy] ${req.url.slice(0, 60)} → 502 ${e?.message}`)
  }
})

server.listen(PORT, () => console.log(`[proxy] local TiTiler stand-in on :${PORT} → ${TARGET}`))
