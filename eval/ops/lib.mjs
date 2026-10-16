// Shared helpers for the operations harness: HTTP with 429 backoff, job-queue runner, tile checks.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(REPO, 'package.json'))
export const sharp = require('sharp')

export const OWNER = 'ops-eval-fixed-token'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Http {
  constructor(base) { this.base = base.replace(/\/$/, '') }
  url(u) { return /^https?:/i.test(u) ? u : this.base + (u.startsWith('/') ? '' : '/') + u }
  /** fetch with 429/503 backoff. Returns the Response (body unread). */
  async fetch(u, init = {}, { retries = 5, timeoutMs = 60000 } = {}) {
    let last
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(this.url(u), { ...init, headers: { 'x-owner-token': OWNER, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) })
        if ((res.status === 429 || res.status === 503) && i < retries) {
          const ra = Number(res.headers.get('retry-after'))
          await res.arrayBuffer().catch(() => {})
          await sleep(Math.min(60000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** i))
          continue
        }
        return res
      } catch (e) { last = e; if (i < retries) await sleep(1500 * (i + 1)) }
    }
    throw last
  }
  async json(u, init, opts) {
    const res = await this.fetch(u, init, opts)
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, body }
  }
  post(u, data, opts) { return this.json(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }, opts) }
}

/** Poll /api/health until every check is ok (llm is client-configured). */
export async function warm(http, maxMs = 240000) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < maxMs) {
    try {
      const { body } = await http.json('/api/health', {}, { retries: 0, timeoutMs: 20000 })
      last = body
      const bad = Object.entries(body.checks || {}).filter(([k, v]) => k !== 'llm' && v !== 'ok' && v !== 'not configured')
      if (!bad.length) return { ok: true, health: body, ms: Date.now() - t0 }
    } catch (e) { last = { error: String(e) } }
    await sleep(5000)
  }
  return { ok: false, health: last, ms: Date.now() - t0 }
}

/** Run one operation through POST /api/jobs -> poll -> GET /api/results. */
export async function runJob(http, { op, args, aoi, label }, { maxMs = 420000 } = {}) {
  const t0 = Date.now()
  const out = { op, args, ms: 0 }
  const sub = await http.post('/api/jobs', { label: label || `ops-eval ${op}`, maxAttempts: 1, jobs: [{ op, args, aoi }] })
  out.submit = { status: sub.status, body: sub.status === 202 ? undefined : sub.body }
  if (sub.status !== 202) { out.ms = Date.now() - t0; out.error = `submit HTTP ${sub.status}: ${JSON.stringify(sub.body).slice(0, 300)}`; return out }
  out.batch = sub.body.id
  let job
  while (Date.now() - t0 < maxMs) {
    await sleep(2500)
    const r = await http.json(`/api/jobs/${sub.body.id}`)
    if (r.status !== 200) { out.error = `poll HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`; break }
    job = r.body.jobs?.[0]
    if (r.body.state === 'finished') break
  }
  out.ms = Date.now() - t0
  out.job = job && { status: job.status, attempts: job.attempts, resultStatus: job.resultStatus, error: job.error, resultId: job.resultId }
  if (!job || !['done', 'failed'].includes(job.status)) { out.error = out.error || `job not finished after ${maxMs}ms (status ${job?.status})`; return out }
  if (job.resultId) {
    const r = await http.json(`/api/results/${job.resultId}`)
    out.resultHttp = r.status
    if (r.status === 200) out.result = r.body.result
    else out.error = `result HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`
  }
  return out
}

// --- geometry -------------------------------------------------------------------------------
export function boxAoi(lon, lat, halfKm) {
  const dLat = halfKm / 110.574
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180))
  const w = lon - dLon, e = lon + dLon, s = lat - dLat, n = lat + dLat
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
}
function flatPts(c, out = []) {
  if (typeof c[0] === 'number') out.push(c)
  else for (const x of c) flatPts(x, out)
  return out
}
export function geomBbox(g) {
  const pts = flatPts(g.coordinates)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z) }

/** Up to 3 tiles: the one at the bbox centre plus nearest neighbours inside the bbox, at the AOI's zoom. */
export function pickTiles(bbox) {
  const [w, s, e, n] = bbox
  const span = Math.max(e - w, 1e-6)
  let z = Math.max(5, Math.min(14, Math.floor(Math.log2(360 / span))))
  const mk = (zz) => {
    const x0 = lon2x(w, zz), x1 = lon2x(e, zz), y0 = lat2y(n, zz), y1 = lat2y(s, zz)
    const cx = lon2x((w + e) / 2, zz), cy = lat2y((s + n) / 2, zz)
    const all = []
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) all.push({ z: zz, x, y, d: Math.abs(x - cx) + Math.abs(y - cy) })
    return { all: all.sort((a, b) => a.d - b.d), cx, cy }
  }
  let t = mk(z)
  while (t.all.length < 3 && z < 14) t = mk(++z)
  const picks = t.all.slice(0, 3).map(({ z: zz, x, y }) => ({ z: zz, x, y }))
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0]]) if (picks.length < 3) picks.push({ z, x: t.cx + dx, y: t.cy + dy })
  return picks
}

/** Decode an image buffer and judge whether it carries information. */
export async function judgeImage(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  let opaque = 0
  const sum = [0, 0, 0], sum2 = [0, 0, 0]
  const colours = new Set()
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 8) continue
    opaque++
    for (let c = 0; c < 3; c++) { const v = data[i * 4 + c]; sum[c] += v; sum2[c] += v * v }
    colours.add(((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3))
  }
  const sd = opaque ? Math.max(...sum.map((s, c) => Math.sqrt(Math.max(0, sum2[c] / opaque - (s / opaque) ** 2)))) : 0
  return { w: info.width, h: info.height, opaque_frac: +(opaque / n).toFixed(3), colours: colours.size, max_sd: +sd.toFixed(2),
    transparent: opaque === 0, uniform: opaque > 0 && (colours.size <= 1 || sd < 1.5) }
}

/** Fetch up to 3 tiles for a template and judge each. */
export async function checkTiles(http, template, bbox) {
  const rows = []
  for (const t of pickTiles(bbox)) {
    const url = template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)
    const row = { ...t, url: url.slice(0, 500) }
    try {
      const r = await http.fetch(url, {}, { retries: 3, timeoutMs: 60000 })
      row.status = r.status
      row.type = r.headers.get('content-type')
      const buf = Buffer.from(await r.arrayBuffer())
      row.bytes = buf.length
      if (r.status === 200 && /^image\//.test(row.type || '')) Object.assign(row, await judgeImage(buf).catch((e) => ({ decode_error: String(e).slice(0, 100) })))
      else if (r.status !== 200) row.body = buf.toString('utf8', 0, 200)
    } catch (e) { row.error = String(e).slice(0, 150) }
    rows.push(row)
  }
  return rows
}
