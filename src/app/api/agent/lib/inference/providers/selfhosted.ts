/** Self-hosted model server provider.
 *
 *  POSTs to {INFERENCE_ENDPOINT}{route} with `{ input }` JSON body.
 *  Expects the response to match NormalizedOutput (or a subset of it).
 *
 *  Auth: INFERENCE_ENDPOINT env var (full base URL, e.g. 'http://localhost:8080').
 *  Route: path on the model server (e.g. '/infer/grounding-dino').
 *
 *  Compatible with:
 *    - FastAPI / Triton / Ray Serve / TorchServe / any HTTP JSON server
 *    - Response must include at least: provenance, confidence, resolution_limit
 *    - Plus one of: geojson (detect), maskUrl|maskPng (segment), labels (classify)
 */

import { fetchWithRetry } from '../../cache'
import type { ModelEntry, NormalizedOutput } from '../registry'

const SELFHOSTED_TIMEOUT_MS = 120_000  // GPU inference can be slow; allow 2 min

export async function infer(
  route: string,
  input: Record<string, unknown>,
  entry: ModelEntry,
): Promise<NormalizedOutput> {
  const endpoint = process.env.INFERENCE_ENDPOINT?.replace(/\/+$/, '').trim()
  if (!endpoint) throw new Error('INFERENCE_ENDPOINT env var is not set')

  const url = `${endpoint}${route.startsWith('/') ? route : `/${route}`}`

  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model: entry.key, task: entry.task }),
    },
    { timeoutMs: SELFHOSTED_TIMEOUT_MS },
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Self-hosted inference HTTP ${res.status} at ${url}: ${body.slice(0, 300)}`)
  }

  let json: Partial<NormalizedOutput> & Record<string, unknown>
  try {
    json = await res.json()
  } catch {
    throw new Error(`Self-hosted inference at ${url}: response is not valid JSON`)
  }

  // Validate + fill required fields
  if (typeof json.confidence !== 'number') {
    json.confidence = 0.5
  }
  json.provenance = `selfhosted:${route}`
  json.resolution_limit = entry.resolutionLimit

  // Basic output-type check
  const hasOutput = json.geojson != null || json.maskPng != null || json.maskUrl != null || Array.isArray(json.labels)
  if (!hasOutput) {
    throw new Error(
      `Self-hosted inference at ${url}: response has none of geojson/maskPng/maskUrl/labels. ` +
      `Check that your model server returns the NormalizedOutput shape.`,
    )
  }

  return json as NormalizedOutput
}
