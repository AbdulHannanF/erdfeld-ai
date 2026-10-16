/**
 * Q-29 — the public key that verifies evidence bundles.
 *
 *   GET /api/evidence/public-key → `{ alg, key_id, public_key_pem, ephemeral, note }`
 *
 * An ephemeral key (no EVIDENCE_SIGNING_KEY configured) is published too, flagged as such: it
 * verifies only bundles signed since the last restart.
 */

import { NextResponse } from 'next/server'

import { EPHEMERAL_KEY_LABEL } from '@/lib/evidence-bundle'
import { getSigningKey } from '@/lib/evidence-key'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const k = getSigningKey()
    return NextResponse.json({
      alg: 'Ed25519',
      key_id: k.keyId,
      public_key_pem: k.publicKeyPem,
      ephemeral: k.kind === 'ephemeral',
      note: k.kind === 'ephemeral' ? EPHEMERAL_KEY_LABEL : 'configured via EVIDENCE_SIGNING_KEY',
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
