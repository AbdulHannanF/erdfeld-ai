/**
 * Q-29 — signed evidence bundle (pure: node:crypto only, no I/O, no environment).
 *
 * A bundle is `{ schema, schema_version, body, signature }`. `body` is the ledger run of one
 * request (plan graph, operation@version, arguments, hashes, provenance items, the cited figures,
 * timings) plus the code SHA and how to re-run it. `signature` is a detached Ed25519 signature
 * over the UTF-8 bytes of `canonicalJson(body)` (sorted keys, see `engine/hash.ts`), so it
 * survives any re-serialisation of the JSON.
 *
 * What a valid bundle proves: this server key vouched for exactly these bytes, and the ledger is
 * internally consistent (every `result_id` is the hash of its `inputs_hash` and its data items).
 * What it does not prove: that the figures are right. Reproducing them is the re-run's job.
 */

import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

import { canonicalJson, resultId } from '../app/api/agent/engine/hash'
import type { LedgerExport } from '../app/api/agent/engine/ledger'

export const BUNDLE_SCHEMA = 'geoagent.evidence-bundle' as const
export const BUNDLE_SCHEMA_VERSION = 1 as const
export const EPHEMERAL_KEY_LABEL = 'ephemeral — not verifiable after restart'

export type KeyKind = 'configured' | 'ephemeral'

export interface BundleNode {
  idx: number
  op: string
  version: string
  args: Record<string, unknown>
  depends_on: number[]
  inputs_hash: string | null
  result_id: string | null
  status: string
  cached: boolean
  started_at: string
  ms: number
  computed_at: string | null
  /** Sources, data items (scene ids, release tags), method and date of the stored result. Null
   *  when the result was not in the store at bundle time. */
  provenance: { sources: string[]; items: string[]; method: string; date?: string } | null
  /** The cited figures (the result's `stats`), verbatim. */
  figures: unknown
}

/** The claim a bundle vouches for (Q-23/Q-27): the verdict, the exact recipe version that decided
 *  it (embedded, so the decision can be re-evaluated from the bundle alone) and the decision trace. */
export interface BundleClaim {
  case_id: string
  claim_type: string
  /** `<id>@<semver>`. */
  recipe: string
  /** The recipe as it was when the verdict was reached. */
  recipe_body: unknown
  claim: string
  params: Record<string, string | number>
  geometry: unknown
  verdict: 'supported' | 'contradicted' | 'cannot_determine'
  confidence: number | null
  decision: { rule: string; reason: string; kind?: string; inputs: Record<string, number | string | null> }
}

export interface BundleBody {
  created_at: string
  /** The commit this server was built from, or "unknown". Never guessed. */
  code_sha: string
  signing: { alg: 'Ed25519'; key_id: string; key_kind: KeyKind }
  /** Present when the run is a claim case. */
  claim?: BundleClaim
  run: {
    run_id: string
    created_at: string
    query: string | null
    aoi: unknown
    focus: { lat: number; lng: number } | null
    nodes: BundleNode[]
  }
  reproduce: { rerun_command: string; verify_command: string }
}

export interface BundleSignature {
  alg: 'Ed25519'
  key_id: string
  /** `configured`, or the honest label for a key that dies with the process. */
  key: 'configured' | typeof EPHEMERAL_KEY_LABEL
  /** base64 of the 64-byte signature. */
  value: string
}

export interface EvidenceBundle {
  schema: typeof BUNDLE_SCHEMA
  schema_version: typeof BUNDLE_SCHEMA_VERSION
  body: BundleBody
  signature: BundleSignature
}

export interface BundleSigner {
  privateKey: KeyObject
  keyId: string
  kind: KeyKind
}

/** First 16 hex chars of the SHA-256 of the public key's SPKI DER. */
export function keyIdOf(publicKey: KeyObject | string): string {
  const k = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  return createHash('sha256').update(k.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
}

export interface BuildOptions {
  codeSha: string
  /** Origin of the server the run lives on, for the re-run command. */
  baseUrl: string
  claim?: BundleClaim
  now?: () => number
}

export function buildBundleBody(ledger: LedgerExport, signer: Pick<BundleSigner, 'keyId' | 'kind'>, opts: BuildOptions): BundleBody {
  const file = `erdfeld-evidence-${ledger.runId}.json`
  return {
    created_at: new Date((opts.now ?? Date.now)()).toISOString(),
    code_sha: opts.codeSha,
    signing: { alg: 'Ed25519', key_id: signer.keyId, key_kind: signer.kind },
    ...(opts.claim ? { claim: opts.claim } : {}),
    run: {
      run_id: ledger.runId,
      created_at: ledger.createdAt,
      query: ledger.query,
      aoi: ledger.aoi,
      focus: ledger.focus,
      nodes: ledger.nodes.map((n) => ({
        idx: n.idx, op: n.op, version: n.version, args: n.args, depends_on: n.dependsOn,
        inputs_hash: n.inputsHash, result_id: n.resultId, status: n.status, cached: n.cached,
        started_at: n.startedAt, ms: n.ms, computed_at: n.computedAt, provenance: n.provenance, figures: n.stats,
      })),
    },
    reproduce: {
      rerun_command: `curl -X POST -H "x-owner-token: $OWNER_TOKEN" ${opts.baseUrl}/api/ledger/${ledger.runId}/rerun`,
      verify_command: `npx tsx scripts/verify-bundle.mts ${file} --rerun ${opts.baseUrl}`,
    },
  }
}

export const signedBytes = (body: BundleBody): Buffer => Buffer.from(canonicalJson(body), 'utf8')

export function signBundle(body: BundleBody, signer: BundleSigner): EvidenceBundle {
  if (body.signing.key_id !== signer.keyId || body.signing.key_kind !== signer.kind) {
    throw new Error('The body names a different signing key than the signer')
  }
  return {
    schema: BUNDLE_SCHEMA,
    schema_version: BUNDLE_SCHEMA_VERSION,
    body,
    signature: {
      alg: 'Ed25519',
      key_id: signer.keyId,
      key: signer.kind === 'ephemeral' ? EPHEMERAL_KEY_LABEL : 'configured',
      value: sign(null, signedBytes(body), signer.privateKey).toString('base64'),
    },
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyReport {
  /** Signature valid under the given key AND the ledger is internally consistent. */
  valid: boolean
  signature: { ok: boolean; keyId: string | null; reason?: string }
  consistency: { ok: boolean; issues: string[] }
  /** Things that could not be checked; they do not make the bundle invalid. */
  warnings: string[]
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function checkSignature(bundle: Record<string, any>, publicKeyPem: string): VerifyReport['signature'] {
  const sig = bundle.signature
  if (!isObj(sig) || typeof sig.value !== 'string' || typeof sig.key_id !== 'string') {
    return { ok: false, keyId: null, reason: 'The bundle has no detached signature.' }
  }
  const out = (reason: string) => ({ ok: false, keyId: sig.key_id as string, reason })
  if (sig.alg !== 'Ed25519') return out(`Unsupported signature algorithm: ${String(sig.alg)}`)
  let key: KeyObject
  try {
    key = createPublicKey(publicKeyPem)
  } catch {
    return out('The public key given is not a valid PEM public key.')
  }
  if (key.asymmetricKeyType !== 'ed25519') return out('The public key given is not an Ed25519 key.')
  const given = keyIdOf(key)
  if (given !== sig.key_id) return out(`The bundle was signed by key ${sig.key_id}, not the key given (${given}).`)
  const body = bundle.body
  // The label outside the signed body must agree with the one inside it, or it could be edited.
  if (!isObj(body) || !isObj(body.signing) || body.signing.key_id !== sig.key_id) {
    return out('The signing key named inside the signed body does not match the signature.')
  }
  const expectedLabel = body.signing.key_kind === 'ephemeral' ? EPHEMERAL_KEY_LABEL : 'configured'
  if (sig.key !== expectedLabel) return out('The key label does not match the one inside the signed body.')
  let ok = false
  try {
    ok = verify(null, Buffer.from(canonicalJson(body), 'utf8'), key, Buffer.from(sig.value, 'base64'))
  } catch {
    ok = false
  }
  return ok ? { ok: true, keyId: sig.key_id } : out('The signature does not match the bundle contents: it was altered after signing, or signed by another key.')
}

/** Internal consistency of the ledger: every result_id is the hash of its inputs_hash and its
 *  data items, and the graph refers only to nodes that exist. */
export function checkConsistency(body: unknown): { issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  const nodes = isObj(body) && isObj(body.run) && Array.isArray(body.run.nodes) ? (body.run.nodes as BundleNode[]) : null
  if (!nodes) return { issues: ['The bundle has no ledger nodes.'], warnings }
  const idxs = new Set<number>()
  for (const n of nodes) {
    if (idxs.has(n.idx)) issues.push(`Node ${n.idx} appears more than once.`)
    idxs.add(n.idx)
  }
  for (const n of nodes) {
    const label = `Node ${n.idx} (${n.op}@${n.version})`
    for (const d of n.depends_on ?? []) if (!idxs.has(d)) issues.push(`${label} depends on node ${d}, which is not in the bundle.`)
    if (n.result_id == null) continue
    if (n.inputs_hash == null) { issues.push(`${label} has a result_id but no inputs_hash.`); continue }
    if (!n.provenance) {
      warnings.push(`${label}: the result was not in the store when the bundle was made, so its result_id ${n.result_id} cannot be checked against its data items.`)
      continue
    }
    const expected = resultId(n.inputs_hash, n.provenance.items)
    if (expected !== n.result_id) {
      issues.push(`${label}: result_id ${n.result_id} is not the hash of its inputs_hash and its recorded data items (expected ${expected}); the items or the hash were edited.`)
    }
  }
  return { issues, warnings }
}

/** Verify a bundle against a trusted public key (PEM). Never throws on a malformed bundle. */
export function verifyBundle(bundle: unknown, publicKeyPem: string): VerifyReport {
  if (!isObj(bundle) || bundle.schema !== BUNDLE_SCHEMA || bundle.schema_version !== BUNDLE_SCHEMA_VERSION || !isObj(bundle.body)) {
    return {
      valid: false,
      signature: { ok: false, keyId: null, reason: `Not a ${BUNDLE_SCHEMA} v${BUNDLE_SCHEMA_VERSION} bundle.` },
      consistency: { ok: false, issues: ['Not an evidence bundle.'] },
      warnings: [],
    }
  }
  const signature = checkSignature(bundle, publicKeyPem)
  const { issues, warnings } = checkConsistency(bundle.body)
  return { valid: signature.ok && issues.length === 0, signature, consistency: { ok: issues.length === 0, issues }, warnings }
}
