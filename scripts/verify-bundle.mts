/**
 * Verify a signed evidence bundle offline (Q-29).
 *
 *   npx tsx scripts/verify-bundle.mts <bundle.json> [--key <public-key.pem> | --key-url <url>]
 *                                      [--rerun <baseUrl>] [--owner-token <token>]
 *
 * Checks the Ed25519 signature over the canonical bytes and the ledger's internal consistency
 * (every result_id matches its inputs_hash and data items). The public key comes from `--key`
 * (a PEM file, fully offline), `--key-url` (e.g. <base>/api/evidence/public-key), or, with
 * `--rerun`, from that server. A key fetched from the server you are checking is only as trusted
 * as that server: pin the PEM for anything that matters.
 *
 * `--rerun <baseUrl>` POSTs /api/ledger/:runId/rerun and reports per node reproduced / changed.
 * Exit codes: 0 valid (and reproduced, if re-run), 1 invalid, 2 usage or network error,
 * 3 valid but the re-run did not reproduce every node.
 */

import { readFileSync } from 'node:fs'

import { verifyBundle, type EvidenceBundle } from '../src/lib/evidence-bundle'
import type { RerunReport } from '../src/app/api/agent/engine/rerun'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const usage = () => {
  console.error('usage: verify-bundle.mts <bundle.json> [--key <pem> | --key-url <url>] [--rerun <baseUrl>] [--owner-token <token>]')
  process.exit(2)
}
if (!file) usage()

async function publicKeyPem(base: string | undefined): Promise<string> {
  const keyFile = flag('--key')
  if (keyFile) return readFileSync(keyFile, 'utf8')
  const url = flag('--key-url') ?? (base ? `${base.replace(/\/$/, '')}/api/evidence/public-key` : undefined)
  if (!url) throw new Error('give the public key with --key <pem file>, --key-url <url>, or --rerun <baseUrl>')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not fetch the public key from ${url}: HTTP ${res.status}`)
  const j = (await res.json()) as { public_key_pem?: string }
  if (!j.public_key_pem) throw new Error(`no public_key_pem at ${url}`)
  return j.public_key_pem
}

async function main() {
  let bundle: EvidenceBundle
  try {
    bundle = JSON.parse(readFileSync(file!, 'utf8'))
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`)
    process.exit(2)
  }
  const base = flag('--rerun')
  const report = verifyBundle(bundle, await publicKeyPem(base))
  console.log(`bundle ${bundle?.body?.run?.run_id ?? '?'}  code ${bundle?.body?.code_sha ?? '?'}  key ${bundle?.signature?.key_id ?? '?'} (${bundle?.signature?.key ?? '?'})`)
  console.log(`signature:   ${report.signature.ok ? 'VALID' : 'INVALID - ' + report.signature.reason}`)
  console.log(`consistency: ${report.consistency.ok ? 'OK' : 'INCONSISTENT'}`)
  for (const i of report.consistency.issues) console.log(`  - ${i}`)
  for (const w of report.warnings) console.log(`  ! ${w}`)
  console.log(report.valid ? 'RESULT: VALID' : 'RESULT: INVALID')
  if (!report.valid) process.exit(1)
  if (!base) return

  const runId = bundle.body.run.run_id
  const headers: Record<string, string> = {}
  const owner = flag('--owner-token') ?? process.env.OWNER_TOKEN
  if (owner) headers['x-owner-token'] = owner
  const res = await fetch(`${base.replace(/\/$/, '')}/api/ledger/${runId}/rerun`, { method: 'POST', headers })
  if (!res.ok) {
    console.error(`re-run failed: HTTP ${res.status} ${await res.text()}`)
    process.exit(2)
  }
  const rerun = (await res.json()) as RerunReport
  console.log(`\nre-run of ${runId}:`)
  let all = true
  for (const n of bundle.body.run.nodes) {
    const r = rerun.nodes.find((x) => x.idx === n.idx)
    // The server compares against its own stored copy; the signed bundle must agree with it.
    const sameRecord = r?.originalResultId === n.result_id
    const outcome = !r ? 'missing' : !sameRecord ? 'changed (server holds a different original than the bundle)' : r.outcome
    if (outcome !== 'reproduced') all = false
    console.log(`  node ${n.idx} ${n.op}@${n.version}: ${outcome}${r?.reason ? ` - ${r.reason}` : ''}`)
  }
  console.log(all ? 'REPRODUCED: every node' : 'NOT FULLY REPRODUCED')
  if (!all) process.exit(3)
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`)
  process.exit(2)
})
