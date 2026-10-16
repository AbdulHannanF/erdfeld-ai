import { describe, expect, it } from 'vitest'
import { describeHealth } from '../health'

const ok = { database: 'ok', stac: 'ok', overpass: 'ok', geo: 'not configured', titiler: 'ok', llm: 'client-configured' }

describe('describeHealth', () => {
  it('is Operational when every configured dependency responds', () => {
    expect(describeHealth({ status: 'ok', checks: ok })).toMatchObject({ state: 'ok', short: 'OPERATIONAL', problems: [] })
  })

  it('is Degraded, naming each failing dependency, and never red for a dependency', () => {
    const v = describeHealth({ status: 'degraded', checks: { ...ok, geo: 'down: timeout', titiler: 'degraded: HTTP 502' } })
    expect(v.state).toBe('degraded')
    expect(v.problems.map((p) => p.name)).toEqual(['Geo service', 'Tile server (titiler)'])
    expect(v.label).toBe('Degraded: Geo service (timeout); Tile server (titiler) (HTTP 502)')
  })

  it('a down database (HTTP 503 with a report) is Degraded with the database named, not Unreachable', () => {
    const v = describeHealth({ status: 'down', checks: { ...ok, database: 'down: connection refused' } })
    expect(v.state).toBe('degraded')
    expect(v.problems).toEqual([{ name: 'Database', detail: 'connection refused' }])
  })

  it('is Unreachable only when there is no report from the app API', () => {
    expect(describeHealth(null).state).toBe('down')
    expect(describeHealth({ error: 'x' }).state).toBe('down')
  })
})
