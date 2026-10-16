/** Colour-vision-deficiency simulation and colour difference (BR-06).
 *
 *  Simulation: Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear sRGB.
 *  Difference: CIEDE2000 (Sharma, Wu & Dalal 2005 formulation) on CIELAB D65. Pure, no DOM. */

export type Cvd = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia'

const MATRICES: Record<Exclude<Cvd, 'normal'>, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLin(v / 255)) as [number, number, number]
}

/** Linear-sRGB triple as seen under `cvd`. */
export function simulateLinear(hex: string, cvd: Cvd): [number, number, number] {
  const rgb = hexToLinear(hex)
  if (cvd === 'normal') return rgb
  const m = MATRICES[cvd]
  return m.map((row) => clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) as [number, number, number]
}

export function simulateHex(hex: string, cvd: Cvd): string {
  const out = simulateLinear(hex, cvd).map((v) => Math.round(clamp01(toSrgb(v)) * 255).toString(16).padStart(2, '0'))
  return `#${out.join('')}`
}

export function linearToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function deltaE2000(l1: [number, number, number], l2: [number, number, number]): number {
  const [L1, a1, b1] = l1
  const [L2, a2, b2] = l2
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2)
  const h = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360)
  const h1p = h(b1, a1p), h2p = h(b2, a2p)
  const dLp = L2 - L1, dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2))
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp /= 2
    else hbp = (hbp + (h1p + h2p < 360 ? 360 : -360)) / 2
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63))
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

/** CIEDE2000 between two sRGB hex colours as seen under `cvd`. */
export function deltaE(hexA: string, hexB: string, cvd: Cvd = 'normal'): number {
  return deltaE2000(linearToLab(simulateLinear(hexA, cvd)), linearToLab(simulateLinear(hexB, cvd)))
}

/** Smallest pairwise difference within a palette, and which pair it is. */
export function minPairwise(colors: string[], cvd: Cvd): { de: number; pair: [string, string] } {
  let best = { de: Infinity, pair: ['', ''] as [string, string] }
  for (let i = 0; i < colors.length; i++)
    for (let j = i + 1; j < colors.length; j++) {
      const de = deltaE(colors[i], colors[j], cvd)
      if (de < best.de) best = { de, pair: [colors[i], colors[j]] }
    }
  return best
}
