/** Q-29 — one-page PDF summary of a signed evidence bundle (pdf-lib). The JSON bundle is the
 *  record; the PDF only restates it for people and says so. Nothing is computed here. */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

import type { EvidenceBundle } from './evidence-bundle'

const MAX_ROWS = 18

export async function bundleSummaryPdf(bundle: EvidenceBundle): Promise<Uint8Array> {
  const { body, signature } = bundle
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const mono = await doc.embedFont(StandardFonts.Courier)
  const supported = new Set(font.getCharacterSet())
  const clean = (s: string) => [...s].map((c) => (supported.has(c.codePointAt(0)!) ? c : '?')).join('')
  let y = 800
  const line = (text: string, o: { size?: number; f?: typeof font; gap?: number; max?: number } = {}) => {
    const size = o.size ?? 9
    let t = clean(text)
    const max = o.max ?? 100
    if (t.length > max) t = t.slice(0, max - 3) + '...'
    page.drawText(t, { x: 40, y, size, font: o.f ?? font, color: rgb(0.1, 0.1, 0.1) })
    y -= o.gap ?? size + 4
  }

  line('Erdfeld AI - evidence summary', { size: 16, f: bold, gap: 22 })
  line(`Run ${body.run.run_id}   created ${body.run.created_at}`)
  if (body.run.query) line(`Query: ${body.run.query}`, { max: 110 })
  line(`Code SHA: ${body.code_sha}`)
  line(`Bundle created: ${body.created_at}`, { gap: 14 })

  line('Signature', { size: 11, f: bold, gap: 15 })
  line(`${signature.alg}, key ${signature.key_id} (${signature.key})`)
  line(signature.value.slice(0, 64), { f: mono, size: 7, gap: 9 })
  line(signature.value.slice(64), { f: mono, size: 7, gap: 14 })
  if (body.signing.key_kind === 'ephemeral') {
    line('This key is ephemeral: it cannot be verified after the server restarts.', { f: bold, gap: 14 })
  }

  line(`Ledger (${body.run.nodes.length} node${body.run.nodes.length === 1 ? '' : 's'})`, { size: 11, f: bold, gap: 15 })
  line('#  operation@version                    status    result_id           items', { f: mono, size: 8, gap: 12 })
  for (const n of body.run.nodes.slice(0, MAX_ROWS)) {
    const row = `${String(n.idx).padEnd(3)}${`${n.op}@${n.version}`.padEnd(37).slice(0, 37)} ${n.status.padEnd(9)} ${(n.result_id ?? '-').padEnd(19)} ${n.provenance?.items.length ?? '?'}`
    line(row, { f: mono, size: 8, gap: 11 })
    const fig = n.figures && typeof n.figures === 'object' ? Object.entries(n.figures as Record<string, unknown>).slice(0, 4) : []
    if (fig.length) line('   figures: ' + fig.map(([k, v]) => `${k}=${typeof v === 'object' ? '[series]' : String(v)}`).join(', '), { f: mono, size: 7, gap: 10, max: 120 })
  }
  if (body.run.nodes.length > MAX_ROWS) line(`... ${body.run.nodes.length - MAX_ROWS} more node(s) in the JSON bundle.`, { gap: 14 })

  y -= 8
  line('Reproduce', { size: 11, f: bold, gap: 15 })
  line(body.reproduce.rerun_command, { f: mono, size: 7, gap: 10, max: 130 })
  line(body.reproduce.verify_command, { f: mono, size: 7, gap: 16, max: 130 })
  line('The JSON bundle is the signed record; this page is a summary of it and is not itself signed.', { size: 8 })
  line('A valid signature shows the bundle was not altered, not that the figures are correct: re-run to reproduce them.', { size: 8 })
  return doc.save()
}
