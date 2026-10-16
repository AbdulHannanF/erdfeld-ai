/** Hardware profile selection (spec §2).
 *
 *  > Design for the 4090 box; degrade to the P1000. Every model entry declares a
 *  > `profile: tiny | base | large`, and a `MODEL_PROFILE` env var (auto-detected
 *  > from available VRAM, overridable) selects which weights load. `tiny` must
 *  > run on 4 GB and on CPU.
 *
 *  | machine  | VRAM  | profile |
 *  |----------|-------|---------|
 *  | 2× 4090  | 48 GB | large   |
 *  | P1000    |  4 GB | tiny    |
 *  | CPU only |  —    | tiny    |
 *
 *  Detection is deliberately conservative: anything unknown, unreadable or
 *  nonsensical resolves to `tiny`, because loading a model the box cannot hold
 *  fails at inference time — long after the user asked a question.
 */

import { execFileSync } from 'child_process'
import { getLogger } from '../logger'
import { MODEL_PROFILES, type ModelProfile } from './model-spec'

export type { ModelProfile }

const log = getLogger('agent/model-profile')

/** Minimum total VRAM (GB) for each tier. Below `base` we run `tiny`. */
export const PROFILE_VRAM_GB = {
  tiny: 0,
  base: 8,
  large: 24,
} as const

/** Least-to-most demanding, for comparisons. */
const RANK: Record<ModelProfile, number> = { tiny: 0, base: 1, large: 2 }

/** Pure: map a total-VRAM reading (GB) to the profile it can support. */
export function profileForVram(vramGb: number | null | undefined): ModelProfile {
  const v = Number(vramGb)
  if (!Number.isFinite(v) || v <= 0) return 'tiny'
  if (v >= PROFILE_VRAM_GB.large) return 'large'
  if (v >= PROFILE_VRAM_GB.base) return 'base'
  return 'tiny'
}

/** Pure: may a box of `boxProfile` load a model declared `modelProfile`? */
export function profileAllows(boxProfile: ModelProfile, modelProfile: ModelProfile): boolean {
  return RANK[modelProfile] <= RANK[boxProfile]
}

/**
 * Pure: resolve the effective profile from an explicit override plus a VRAM
 * reading. An unrecognised override is ignored rather than fatal — a typo in
 * `.env` should degrade, not break the app.
 */
export function resolveModelProfile(opts: { env?: string; vramGb?: number | null }): ModelProfile {
  const explicit = (opts.env ?? '').trim().toLowerCase() as ModelProfile
  if (explicit && (MODEL_PROFILES as readonly string[]).includes(explicit)) return explicit
  if (explicit) {
    log.warn({ MODEL_PROFILE: opts.env }, 'unrecognised MODEL_PROFILE — falling back to VRAM detection')
  }
  return profileForVram(opts.vramGb)
}

// ---------------------------------------------------------------------------
// VRAM detection (impure, cached for the process lifetime)
// ---------------------------------------------------------------------------

let vramCache: number | null | undefined

/**
 * Total VRAM across NVIDIA GPUs, in GB, via `nvidia-smi`. Returns null when no
 * NVIDIA GPU is present or the tool is unavailable — the CPU-only case, which
 * resolves to `tiny`.
 *
 * Summed across devices: the target box is 2× 24 GB and is meant to read 48.
 */
export function detectVramGb(): number | null {
  if (vramCache !== undefined) return vramCache
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const totalMb = out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => a + b, 0)
    vramCache = totalMb > 0 ? totalMb / 1024 : null
  } catch {
    // No NVIDIA GPU, no driver, or nvidia-smi not on PATH — all mean "assume CPU".
    vramCache = null
  }
  return vramCache
}

/** The effective profile for this process: `MODEL_PROFILE` if set, else detected. */
export function currentModelProfile(): ModelProfile {
  return resolveModelProfile({ env: process.env.MODEL_PROFILE, vramGb: detectVramGb() })
}

/** Test seam — reset the memoised VRAM reading. */
export function _resetVramCache(): void {
  vramCache = undefined
}
