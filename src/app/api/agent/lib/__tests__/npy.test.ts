/** NPY parser tests (lib/npy.ts) — offline, synthetic buffers.
 *  The semivariogram math these used to accompany moved to
 *  lib/analysis/__tests__/operations.test.ts in Phase 2.5.
 */

import { describe, it, expect } from 'vitest'
import { parseNpy } from '../npy'

// ---------------------------------------------------------------------------
// NPY builder (mirrors numpy.save v1 format)
// ---------------------------------------------------------------------------

function buildNpy(shape: number[], values: number[], descr = '<f8'): Buffer {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`
  // Pad so magic+version+len+header is a multiple of 64, newline-terminated.
  const baseLen = 10 + header.length + 1
  const pad = (64 - (baseLen % 64)) % 64
  header = header + ' '.repeat(pad) + '\n'

  const itemSize = descr === '<f8' ? 8 : descr === '<f4' ? 4 : 1
  const data = Buffer.alloc(values.length * itemSize)
  values.forEach((v, i) => {
    if (descr === '<f8') data.writeDoubleLE(v, i * 8)
    else if (descr === '<f4') data.writeFloatLE(v, i * 4)
    else data[i] = v
  })

  const head = Buffer.alloc(10)
  head[0] = 0x93
  head.write('NUMPY', 1, 'ascii')
  head[6] = 1
  head[7] = 0
  head.writeUInt16LE(header.length, 8)
  return Buffer.concat([head, Buffer.from(header, 'ascii'), data])
}

describe('parseNpy', () => {
  it('round-trips a float64 3-D array', () => {
    const values = Array.from({ length: 2 * 3 * 4 }, (_, i) => i / 10)
    const parsed = parseNpy(buildNpy([2, 3, 4], values))
    expect(parsed.shape).toEqual([2, 3, 4])
    expect(parsed.dtype).toBe('<f8')
    expect(Array.from(parsed.data)).toEqual(values)
  })

  it('round-trips float32 and uint8', () => {
    const f4 = parseNpy(buildNpy([4], [1.5, -2.5, 0, 3.25], '<f4'))
    expect(Array.from(f4.data)).toEqual([1.5, -2.5, 0, 3.25])
    const u1 = parseNpy(buildNpy([3], [0, 128, 255], '|u1'))
    expect(Array.from(u1.data)).toEqual([0, 128, 255])
  })

  it('rejects non-NPY buffers with an honest error', () => {
    expect(() => parseNpy(Buffer.from('{"detail":"error"}'))).toThrow(/not an NPY/)
  })
})

describe('parseNpy: integer dtypes titiler returns for classified and DEM rasters', () => {
  const raw = (descr: string, size: number, write: (b: Buffer) => void, n: number) => {
    const header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${n},), }`
    const base = 10 + header.length + 1
    const h = header + ' '.repeat((64 - (base % 64)) % 64) + '\n'
    const data = Buffer.alloc(n * size)
    write(data)
    const head = Buffer.alloc(10)
    head[0] = 0x93; head.write('NUMPY', 1, 'ascii'); head[6] = 1; head.writeUInt16LE(h.length, 8)
    return Buffer.concat([head, Buffer.from(h, 'ascii'), data])
  }

  it('reads int8, int32 and uint32', () => {
    expect(Array.from(parseNpy(raw('|i1', 1, (b) => { b.writeInt8(-5, 0); b.writeInt8(7, 1) }, 2)).data)).toEqual([-5, 7])
    expect(Array.from(parseNpy(raw('<i4', 4, (b) => { b.writeInt32LE(-100000, 0); b.writeInt32LE(250000, 4) }, 2)).data)).toEqual([-100000, 250000])
    expect(Array.from(parseNpy(raw('<u4', 4, (b) => { b.writeUInt32LE(4_000_000_000, 0) }, 1)).data)).toEqual([4_000_000_000])
  })
})
