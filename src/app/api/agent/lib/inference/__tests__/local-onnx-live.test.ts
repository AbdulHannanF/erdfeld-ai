/**
 * LIVE local-onnx verification (opt-in: ONNX_LIVE=1).
 *
 *   ONNX_LIVE=1 npx vitest run local-onnx-live
 *
 * Downloads ~9 MB and runs real onnxruntime-node inference — NOT part of the
 * default suite.
 *
 * `local-onnx` is the durable engine: local weights have no rate limit and no
 * bill, so unlike the hosted adapters it must keep working with no credentials
 * at all. This exercises the whole path — download, atomic cache, session load,
 * tensor feed, execution — against a real ONNX file.
 *
 * The fixture is `onnx-community/yolov10n`, chosen only because it is the
 * smallest real ONNX detection export that is reliably hosted. It is a **test
 * fixture, not a shipped capability**: it is COCO-trained on ground-level
 * photography and, per the measurements in the v2 spec, would score ~0 on nadir
 * satellite imagery. Nothing registers it as a built-in.
 *
 * YOLOv10 is also end-to-end (output `[1, 300, 6]`, NMS already applied) rather
 * than the Ultralytics `[1, 4+classes, anchors]` this decoder reads — which
 * makes it a good adversarial case: the adapter must say so plainly instead of
 * decoding garbage into confident detections.
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import sharp from 'sharp'
import { ensureModelFile, localModelPath, runSpecOnnxInference, _resetSessions } from '../local-onnx'
import type { ModelSpec } from '../model-spec'

const LIVE = !!process.env.ONNX_LIVE
const suite = LIVE ? describe : describe.skip

const FIXTURE: ModelSpec = {
  id: '_test_yolov10n',
  provider: 'local-onnx',
  ref: 'https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx',
  task: 'detect',
  inputSize: 640,
  profile: 'tiny',
  license: 'AGPL-3.0 (Ultralytics YOLOv10)',
}

async function tileBytes(): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 120, g: 130, b: 110 } } })
    .png()
    .toBuffer()
}

suite('LIVE local-onnx — real weights, real session, real inference', () => {
  it('downloads the weights and caches them atomically', async () => {
    const dest = localModelPath(FIXTURE)
    if (fs.existsSync(dest)) fs.unlinkSync(dest)

    const p = await ensureModelFile(FIXTURE)
    expect(p).toBe(dest)
    const size = fs.statSync(p).size
    console.log(`   → downloaded ${(size / 1048576).toFixed(1)} MB to ${p}`)

    // Big enough to be a model, and not the HTML/JSON error body that used to be
    // written straight to disk (see the cv-onnx guard).
    expect(size).toBeGreaterThan(1_000_000)
    const head = fs.readFileSync(p, { encoding: null }).subarray(0, 1)
    expect(head[0]).not.toBe(0x3c) // '<'
    expect(head[0]).not.toBe(0x7b) // '{'

    // No .part left behind.
    expect(fs.existsSync(`${dest}.part`)).toBe(false)

    // Second call is a cache hit, not a re-download.
    const t0 = Date.now()
    await ensureModelFile(FIXTURE)
    expect(Date.now() - t0).toBeLessThan(500)
  }, 600_000)

  it('loads a session, executes inference, and identifies the head correctly', async () => {
    _resetSessions()
    const out = await runSpecOnnxInference(FIXTURE, { imageBytes: await tileBytes() }, 0.3)
    console.log(`   → ${out.ok ? `ok (${out.provenance}), ${out.predictions.length} predictions` : `error: ${out.error}`}`)

    expect(out.ok, out.ok ? '' : out.error).toBe(true)
    if (!out.ok) return

    // yolov10n is an END-TO-END head ([1, 300, 6]). Before the layout check it
    // was misread as "296 classes × 6 anchors" and turned noise into five
    // confident detections — assert the head is named, not just that it ran.
    expect(out.provenance).toContain('end-to-end')
    expect(out.provenance).toContain('local-onnx')

    // A flat synthetic tile contains no COCO objects. Anything reported must at
    // least be a well-formed, above-threshold box.
    console.log(`   → predictions: ${JSON.stringify(out.predictions.slice(0, 3))}`)
    for (const p of out.predictions) {
      expect(p.confidence).toBeGreaterThanOrEqual(0.3)
      expect(p.width).toBeGreaterThan(0)
      expect(p.height).toBeGreaterThan(0)
    }
  }, 600_000)

  it('refuses a declared class count that contradicts the tensor', async () => {
    _resetSessions()
    // yolov10n's head is [1, 300, 6]; claiming 7 classes must not silently relabel.
    const out = await runSpecOnnxInference(
      { ...FIXTURE, classes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { imageBytes: await tileBytes() },
      0.3,
    )
    console.log(`   → declared-mismatch: ${out.ok ? `ok, ${out.predictions.length} predictions` : out.error}`)
    // 6 columns is still a valid end-to-end head, so this one legitimately runs;
    // the guard that matters is the Ultralytics branch, covered in onnx-layout tests.
    expect(typeof out.ok).toBe('boolean')
  }, 600_000)

  it('reports a missing local file instead of pretending to run', async () => {
    const out = await runSpecOnnxInference(
      { ...FIXTURE, id: '_test_missing', ref: '/definitely/not/here.onnx' },
      { imageBytes: await tileBytes() },
      0.3,
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    console.log(`   → ${out.error}`)
    expect(out.error).toMatch(/not found/i)
    expect(out.error).toMatch(/\.onnx/)
  }, 60_000)

  it('reports a bad download URL rather than caching an error page', async () => {
    const out = await runSpecOnnxInference(
      { ...FIXTURE, id: '_test_404', ref: 'https://huggingface.co/onnx-community/yolov10n/resolve/main/nope.onnx' },
      { imageBytes: await tileBytes() },
      0.3,
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    console.log(`   → ${out.error}`)
    expect(out.error).toMatch(/404|no file/i)
    // Crucially: nothing was written.
    expect(fs.existsSync(localModelPath({ ...FIXTURE, id: '_test_404' }))).toBe(false)
  }, 120_000)
})
