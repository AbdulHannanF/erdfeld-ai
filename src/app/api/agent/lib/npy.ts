/** NumPy `.npy` parsing — the wire format titiler returns from
 *  `/stac/feature.npy` and `/cog/feature.npy`, which is how every
 *  polygon-clipped statistic in this codebase reaches real per-pixel values
 *  (see lib/pixels.ts).
 *
 *  This file was `variogram.ts` and also held the semivariogram math for the
 *  retired `compute_variogram` tool. Phase 2.5 generalised that math
 *  (directional lags, three models, seven further operations on the same
 *  substrate) into lib/analysis/operations.ts, so the parser is all that
 *  remains — and the filename now says so.
 */

export interface NpyArray {
  shape: number[]
  /** Flat C-order values (row-major, band-major for 3-D). */
  data: Float64Array
  dtype: string
}

/** Parse a NumPy .npy v1/v2 buffer (little-endian numeric dtypes only). Returns
 *  the values as Float64Array regardless of source dtype. Throws on anything
 *  that is not a well-formed npy — the caller surfaces an honest error. */
export function parseNpy(buf: Buffer): NpyArray {
  if (buf.length < 10 || buf[0] !== 0x93 || buf.subarray(1, 6).toString('ascii') !== 'NUMPY') {
    throw new Error('not an NPY buffer')
  }
  const major = buf[6]
  const headerLen = major >= 2 ? buf.readUInt32LE(8) : buf.readUInt16LE(8)
  const headerStart = major >= 2 ? 12 : 10
  const header = buf.subarray(headerStart, headerStart + headerLen).toString('ascii')

  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/)
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]*)\)/)
  const fortranMatch = header.match(/'fortran_order'\s*:\s*(True|False)/)
  if (!descrMatch || !shapeMatch) throw new Error('malformed NPY header')
  if (fortranMatch?.[1] === 'True') throw new Error('fortran-order NPY not supported')

  const dtype = descrMatch[1]
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
  const count = shape.reduce((a, b) => a * b, 1)
  const dataStart = headerStart + headerLen

  const data = new Float64Array(count)
  switch (dtype) {
    case '<f8':
      for (let i = 0; i < count; i++) data[i] = buf.readDoubleLE(dataStart + i * 8)
      break
    case '<f4':
      for (let i = 0; i < count; i++) data[i] = buf.readFloatLE(dataStart + i * 4)
      break
    case '<i2':
      for (let i = 0; i < count; i++) data[i] = buf.readInt16LE(dataStart + i * 2)
      break
    case '<u2':
      for (let i = 0; i < count; i++) data[i] = buf.readUInt16LE(dataStart + i * 2)
      break
    case '|u1':
    case '<u1':
    case '|b1':
      for (let i = 0; i < count; i++) data[i] = buf[dataStart + i]
      break
    case '|i1':
      for (let i = 0; i < count; i++) data[i] = buf.readInt8(dataStart + i)
      break
    case '<i4':
      for (let i = 0; i < count; i++) data[i] = buf.readInt32LE(dataStart + i * 4)
      break
    case '<u4':
      for (let i = 0; i < count; i++) data[i] = buf.readUInt32LE(dataStart + i * 4)
      break
    default:
      throw new Error(`unsupported NPY dtype ${dtype}`)
  }
  return { shape, data, dtype }
}
