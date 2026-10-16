/** GET /api/operations[?name=<operation>] — the operation registry as JSON (ADR-0001 §1, Q-41).
 *
 *  Exactly what the planner may use: each operation's name, version, description, parameter
 *  JSON Schema, output kind, sensors, resolution, spatial/temporal limits, cost, limitations and
 *  what its confidence means. Adding an operation to the registry adds it here; nothing else
 *  needs to change. Operations gated by an env flag (the parked CV detectors) appear only while
 *  the flag is on, because the registry is the source of truth for what can run.
 *
 *  `name` narrows the answer to one operation (404 when the registry has none of that name).
 */

import { NextRequest } from 'next/server'

import { OperationsQuerySchema, queryObject, validate } from '@/lib/api-schemas'
import { registryJson } from '../agent/engine/registry'

export const dynamic = 'force-dynamic'

export function GET(req: NextRequest) {
  const query = validate(OperationsQuerySchema, queryObject(req.nextUrl.searchParams))
  if (!query.ok) return query.response
  const all = registryJson()
  const name = query.data.name
  const operations = name ? all.filter((o) => o.name === name) : all
  if (name && operations.length === 0) return Response.json({ error: 'not_found', message: `No operation named ${name}.` }, { status: 404 })
  return Response.json({ schema: 'operations/1', operations })
}
