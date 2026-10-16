/** Pin a toolbox operation to the scenes chosen on the timeline.
 *
 *  An operation reads time through its own arguments: `scene_id` (one exact item), `date`, `start` and
 *  `end`, or a pair (`before` / `after`, `date` / `date2`). This maps chosen scenes onto whichever of
 *  those the operation declares, and says plainly when it cannot: an operation with no date argument,
 *  or one that cannot read the scene's sensor, is not run on a scene it would silently replace.
 *  Pure: no DOM, no fetch.
 */

import type { OperationInfo } from '@/lib/operations-client'

/** The scene fields a pin needs; `SceneRecord` from the catalogue satisfies it. */
export interface PinScene {
  id: string
  date: string
  sensor: 'sentinel-2' | 'landsat' | 'sentinel-1'
}

/** The sensor id operations list, per catalogue sensor; null for radar, which no dated operation reads. */
export const OP_SENSOR: Record<PinScene['sensor'], string | null> = {
  'sentinel-2': 'sentinel-2-l2a',
  landsat: 'landsat-c2-l2',
  'sentinel-1': null,
}

export interface PinnedRun {
  args: Record<string, unknown>
  /** What the job is called: the operation and the day or days. */
  label: string
}

export interface PinPlan {
  runs: PinnedRun[]
  /** Argument names the scenes decide; the dialog does not ask for them. */
  pinned: string[]
  /** Why the operation cannot run on these scenes; empty when it can. */
  problems: string[]
}

const has = (op: OperationInfo, name: string) => name in op.params.properties

/** Whether the operation can be pinned to a scene at all (it has a date argument). */
export function isDatePinnable(op: OperationInfo): boolean {
  return ['scene_id', 'date', 'start', 'before'].some((k) => has(op, k))
}

export function planPins(op: OperationInfo, scenes: PinScene[], title: string): PinPlan {
  const none = (problem: string): PinPlan => ({ runs: [], pinned: [], problems: [problem] })
  if (scenes.length === 0) return none('Choose at least one scene on the timeline.')
  if (!isDatePinnable(op)) return none(`${title} has no date or scene argument, so it cannot be pinned to a scene. It reads the latest imagery.`)

  const sorted = [...scenes].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const problems: string[] = []
  for (const s of sorted) {
    const sensorId = OP_SENSOR[s.sensor]
    if (!sensorId) problems.push(`${title} does not read Sentinel-1 scenes.`)
    else if (op.sensors.length > 0 && !op.sensors.includes(sensorId)) problems.push(`${title} reads ${op.sensors.join(', ')}, not ${s.sensor === 'landsat' ? 'Landsat' : 'Sentinel-2'} (scene ${s.date}).`)
  }
  if (problems.length) return { runs: [], pinned: [], problems: [...new Set(problems)] }

  const sensorArg = (s: PinScene): Record<string, unknown> => {
    if (!has(op, 'sensor')) return {}
    const choices = op.params.properties.sensor.enum
    const id = OP_SENSOR[s.sensor]!
    return !choices || choices.includes(id) ? { sensor: id } : {}
  }

  // a pair: two scenes, the earlier first
  const pairKeys: [string, string] | null = has(op, 'before') && has(op, 'after') ? ['before', 'after'] : has(op, 'date2') ? ['date', 'date2'] : null
  if (pairKeys) {
    if (sorted.length !== 2) return none(`${title} compares two dates: choose exactly two scenes (you chose ${sorted.length}).`)
    if (sorted[0].sensor !== sorted[1].sensor) return none(`${title} compares two dates of one sensor; the two scenes are different sensors.`)
    if (sorted[0].date === sorted[1].date) return none(`${title} needs two different dates.`)
    return {
      runs: [{ args: { ...sensorArg(sorted[0]), [pairKeys[0]]: sorted[0].date, [pairKeys[1]]: sorted[1].date }, label: `${title} ${sorted[0].date} to ${sorted[1].date}` }],
      pinned: [...pairKeys, ...(has(op, 'sensor') ? ['sensor'] : [])],
      problems: [],
    }
  }

  const pinned: string[] = []
  const runs = sorted.map((s): PinnedRun => {
    const args: Record<string, unknown> = { ...sensorArg(s) }
    if (has(op, 'scene_id')) {
      args.scene_id = s.id
      if (has(op, 'date')) args.date = s.date
    } else if (has(op, 'date')) args.date = s.date
    else { args.start = s.date; args.end = s.date }
    return { args, label: `${title} ${s.date}` }
  })
  for (const k of ['scene_id', 'date', 'start', 'end', 'sensor']) if (has(op, k) && k in runs[0].args) pinned.push(k)
  return { runs, pinned, problems: [] }
}
