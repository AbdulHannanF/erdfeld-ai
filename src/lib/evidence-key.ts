/**
 * Q-29 — the server's evidence signing key (server only).
 *
 * `EVIDENCE_SIGNING_KEY` is an Ed25519 private key as PKCS8 PEM, either as is (a `\n` escape for
 * newlines is accepted) or base64 of that PEM. A value that is set but unusable throws: it never
 * falls back to another key. With nothing configured an ephemeral key is generated once per
 * process and every bundle it signs says so; it cannot be checked after a restart.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

import { keyIdOf, type BundleSigner } from './evidence-bundle'

export interface SigningKey extends BundleSigner {
  publicKeyPem: string
}

function toPem(raw: string): string {
  const v = raw.trim().replace(/\\n/g, '\n')
  return v.startsWith('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')
}

function fromPrivate(privateKey: KeyObject, kind: SigningKey['kind']): SigningKey {
  const pub = createPublicKey(privateKey)
  return { privateKey, kind, keyId: keyIdOf(pub), publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString() }
}

export function loadSigningKey(raw: string | undefined): SigningKey {
  if (raw && raw.trim()) {
    let key: KeyObject
    try {
      key = createPrivateKey(toPem(raw))
    } catch {
      throw new Error('EVIDENCE_SIGNING_KEY is set but is not a PKCS8 PEM private key (plain or base64).')
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('EVIDENCE_SIGNING_KEY must be an Ed25519 key.')
    return fromPrivate(key, 'configured')
  }
  return fromPrivate(generateKeyPairSync('ed25519').privateKey, 'ephemeral')
}

// Route bundles can load this module more than once; the key must be one per process.
const SLOT = Symbol.for('geoagent.evidence-signing-key')

export function getSigningKey(): SigningKey {
  const g = globalThis as unknown as Record<symbol, SigningKey | undefined>
  return (g[SLOT] ??= loadSigningKey(process.env.EVIDENCE_SIGNING_KEY))
}

/** The commit the server was built from. `GIT_SHA` wins, then the build-time value; else "unknown". */
export function codeSha(): string {
  return process.env.GIT_SHA || process.env.NEXT_PUBLIC_GIT_SHA || 'unknown'
}
