/**
 * What the status pill says, from the body of `GET /api/health`.
 *
 * Red ("Unreachable") is only for the app's own API not answering at all. A dependency that is
 * down (the database included) makes the app degraded, never unreachable: the app answered, and
 * the tooltip names what is wrong.
 */

export type HealthState = 'unknown' | 'ok' | 'degraded' | 'down'

export interface HealthView {
  state: HealthState
  /** The pill's short label. */
  short: string
  /** Tooltip / assistive text. */
  label: string
  /** The dependencies that are not healthy, with the server's reason. */
  problems: Array<{ name: string; detail: string }>
}

const NAMES: Record<string, string> = {
  database: 'Database',
  geo: 'Geo service',
  titiler: 'Tile server (titiler)',
  stac: 'Imagery catalogue (STAC)',
  overpass: 'OpenStreetMap (Overpass)',
}

const SHORT: Record<HealthState, string> = { unknown: 'CHECKING', ok: 'OPERATIONAL', degraded: 'DEGRADED', down: 'UNREACHABLE' }

export function describeHealth(body: unknown): HealthView {
  const checks = (body as { checks?: Record<string, unknown> } | null)?.checks
  if (!checks || typeof checks !== 'object') {
    return { state: 'down', short: SHORT.down, label: 'The Erdfeld API did not return a health report', problems: [] }
  }
  const problems = Object.entries(NAMES).flatMap(([key, name]) => {
    const v = checks[key]
    return typeof v === 'string' && v !== 'ok' && v !== 'not configured' ? [{ name, detail: v.replace(/^(down|degraded):\s*/, '') }] : []
  })
  if (problems.length === 0) return { state: 'ok', short: SHORT.ok, label: 'Operational: the database and data services respond', problems }
  return {
    state: 'degraded',
    short: SHORT.degraded,
    label: `Degraded: ${problems.map((p) => `${p.name} (${p.detail})`).join('; ')}`,
    problems,
  }
}

export const CHECKING: HealthView = { state: 'unknown', short: SHORT.unknown, label: 'Checking the services', problems: [] }
export const UNREACHABLE: HealthView = { state: 'down', short: SHORT.down, label: 'The Erdfeld API is not reachable', problems: [] }
