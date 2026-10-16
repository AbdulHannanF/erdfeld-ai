import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { canonicalJson, resultId } from '../../app/api/agent/engine/hash'
import type { LedgerExport } from '../../app/api/agent/engine/ledger'
import {
  EPHEMERAL_KEY_LABEL, buildBundleBody, keyIdOf, signBundle, verifyBundle, type EvidenceBundle,
} from '../evidence-bundle'
import { loadSigningKey } from '../evidence-key'

const items = ['S2A_T43RGN_20260905', 'S2B_T43RGN_20260910']
const inputs = 'a'.repeat(64)
const ledger: LedgerExport = {
  runId: 'run1', createdAt: '2026-10-01T00:00:00.000Z', query: 'b08 kasur', aoi: { type: 'Polygon' }, focus: null,
  nodes: [
    {
      idx: 0, op: 'render_raster', version: '1', args: { band: 'B08', z: 1 }, dependsOn: [], inputsHash: inputs,
      resultId: resultId(inputs, items), status: 'ok', cached: false, startedAt: '2026-10-01T00:00:00.000Z', ms: 12,
      provenance: { sources: ['Sentinel-2 L2A'], items, method: 'stac' }, computedAt: '2026-10-01T00:00:01.000Z',
      stats: { mean: 0.42, n: 7 },
    },
    {
      idx: 1, op: 'stats', version: '2', args: { from: '${node:0}' }, dependsOn: [0], inputsHash: 'b'.repeat(64),
      resultId: null, status: 'skipped', cached: false, startedAt: '2026-10-01T00:00:02.000Z', ms: 0,
      provenance: null, computedAt: null, stats: null,
    },
  ],
}

const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const key = loadSigningKey(pem())
const make = (signer = key): EvidenceBundle =>
  signBundle(buildBundleBody(ledger, signer, { codeSha: 'abc123', baseUrl: 'http://x', now: () => 0 }), signer)
const clone = (b: EvidenceBundle): any => JSON.parse(JSON.stringify(b))

describe('signed evidence bundle', () => {
  it('round-trips through JSON and verifies', () => {
    const r = verifyBundle(clone(make()), key.publicKeyPem)
    expect(r).toMatchObject({ valid: true, signature: { ok: true, keyId: key.keyId }, consistency: { ok: true, issues: [] } })
  })

  it('records the code sha and re-run commands in the signed body, and no owner token', () => {
    const b = make()
    expect(b.body.code_sha).toBe('abc123')
    expect(b.body.reproduce.rerun_command).toContain('/api/ledger/run1/rerun')
    expect(b.body.reproduce.verify_command).toContain('verify-bundle.mts')
    expect(JSON.stringify(b)).not.toMatch(/ownerToken/)
  })

  it.each([
    ['a figure', (b: any) => { b.body.run.nodes[0].figures.mean = 0.43 }],
    ['an item id', (b: any) => { b.body.run.nodes[0].provenance.items[0] = 'S2A_T43RGN_20260906' }],
    ['an argument', (b: any) => { b.body.run.nodes[0].args.band = 'B04' }],
    ['the code sha', (b: any) => { b.body.code_sha = 'def' }],
    ['the signature bytes', (b: any) => { const v = Buffer.from(b.signature.value, 'base64'); v[0] ^= 1; b.signature.value = v.toString('base64') }],
  ])('rejects a bundle with %s changed', (_n, edit) => {
    const b = clone(make())
    edit(b)
    const r = verifyBundle(b, key.publicKeyPem)
    expect(r.valid).toBe(false)
    expect(r.signature.ok).toBe(false)
  })

  it('rejects a different key, and says which key signed', () => {
    const other = loadSigningKey(undefined)
    const r = verifyBundle(clone(make()), other.publicKeyPem)
    expect(r.valid).toBe(false)
    expect(r.signature.reason).toContain(key.keyId)
  })

  it('a signature made by another key under the right key id still fails', () => {
    const other = loadSigningKey(undefined)
    const claimed = { ...other, keyId: key.keyId, kind: 'configured' as const }
    const forged = clone(signBundle(buildBundleBody(ledger, claimed, { codeSha: 'x', baseUrl: 'u' }), claimed))
    expect(verifyBundle(forged, key.publicKeyPem).signature.ok).toBe(false)
  })

  it('labels an ephemeral key honestly, and the label cannot be stripped', () => {
    const eph = loadSigningKey(undefined)
    expect(eph.kind).toBe('ephemeral')
    const b = clone(make(eph))
    expect(b.signature.key).toBe(EPHEMERAL_KEY_LABEL)
    expect(b.body.signing.key_kind).toBe('ephemeral')
    expect(verifyBundle(b, eph.publicKeyPem).valid).toBe(true)
    b.signature.key = 'configured'
    expect(verifyBundle(b, eph.publicKeyPem).valid).toBe(false)
  })

  it('loads a configured key as PEM and base64 PEM, and rejects junk instead of falling back', () => {
    const p = pem()
    const a = loadSigningKey(p)
    expect(a.kind).toBe('configured')
    expect(loadSigningKey(Buffer.from(p).toString('base64')).keyId).toBe(a.keyId)
    expect(() => loadSigningKey('not a key')).toThrow(/EVIDENCE_SIGNING_KEY/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => loadSigningKey(rsa)).toThrow(/Ed25519/)
  })

  it('canonicalisation does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }))
    const b = make()
    const rev = (v: any): any => Array.isArray(v) ? v.map(rev) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, rev(v[k])])) : v
    expect(verifyBundle(rev(b), key.publicKeyPem).valid).toBe(true)
  })

  it('catches an edited item even when the edited body is re-signed (result_id consistency)', () => {
    const b = clone(make())
    b.body.run.nodes[0].provenance.items.push('S2C_FAKE')
    const r = verifyBundle(signBundle(b.body, key), key.publicKeyPem)
    expect(r.signature.ok).toBe(true)
    expect(r.valid).toBe(false)
    expect(r.consistency.issues[0]).toMatch(/Node 0.*result_id/)
  })

  it('flags a dangling dependency, and only warns on a result missing from the store', () => {
    const b = clone(make())
    b.body.run.nodes[1].depends_on = [9]
    expect(verifyBundle(signBundle(b.body, key), key.publicKeyPem).consistency.issues[0]).toMatch(/depends on node 9/)
    const c = clone(make())
    c.body.run.nodes[0].provenance = null
    const r = verifyBundle(signBundle(c.body, key), key.publicKeyPem)
    expect(r.valid).toBe(true)
    expect(r.warnings[0]).toMatch(/cannot be checked/)
  })

  it('does not throw on malformed input', () => {
    for (const x of [null, 'x', {}, { schema: 'geoagent.evidence-bundle', schema_version: 1, body: {} }]) {
      expect(verifyBundle(x, key.publicKeyPem).valid).toBe(false)
    }
    expect(keyIdOf(key.publicKeyPem)).toBe(key.keyId)
  })
})
