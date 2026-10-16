/** Refuse-to-write check for a harvested registry snapshot.
 *
 *  A harvest that returns far fewer datasets than the committed snapshot is almost always a
 *  broken run (a catalogue down, a changed response shape), not a real removal. The harvester
 *  uses this to stop before overwriting the snapshot.
 */
export interface SnapshotShrinkCheck {
  ok: boolean
  message: string
}

export function checkSnapshotShrink(previousTotal: number | null, nextTotal: number, minRatio = 0.9): SnapshotShrinkCheck {
  if (previousTotal === null || previousTotal <= 0) {
    return { ok: true, message: 'no previous snapshot to compare with' }
  }
  const ratio = nextTotal / previousTotal
  if (ratio < minRatio) {
    return {
      ok: false,
      message: `new total ${nextTotal} is ${(ratio * 100).toFixed(1)}% of the previous ${previousTotal} (minimum ${(minRatio * 100).toFixed(0)}%)`,
    }
  }
  return { ok: true, message: `new total ${nextTotal} vs previous ${previousTotal} (${(ratio * 100).toFixed(1)}%)` }
}

/** Snapshot size budget: the snapshot ships server-side in the bundle, so growth is a cost. */
export const SNAPSHOT_BUDGET_MB = 10

export function checkSnapshotSize(sizeMb: number, budgetMb = SNAPSHOT_BUDGET_MB): SnapshotShrinkCheck {
  return sizeMb > budgetMb
    ? { ok: false, message: `snapshot is ${sizeMb.toFixed(2)} MB, over the ${budgetMb} MB budget` }
    : { ok: true, message: `snapshot ${sizeMb.toFixed(2)} MB (budget ${budgetMb} MB)` }
}

export interface RegistryDiff {
  added: Array<{ id: string; title: string }>
  removed: Array<{ id: string; title: string }>
}

/** Datasets added and removed between two snapshots, by id, sorted for a stable report. */
export function diffSnapshots(
  previous: ReadonlyArray<{ id: string; title: string }>,
  next: ReadonlyArray<{ id: string; title: string }>,
): RegistryDiff {
  const prevIds = new Set(previous.map((e) => e.id))
  const nextIds = new Set(next.map((e) => e.id))
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
  return {
    added: next.filter((e) => !prevIds.has(e.id)).map(({ id, title }) => ({ id, title })).sort(byId),
    removed: previous.filter((e) => !nextIds.has(e.id)).map(({ id, title }) => ({ id, title })).sort(byId),
  }
}

/** Markdown change report for the refresh PR body. Lists are capped so the PR stays readable. */
export function renderDiffMd(diff: RegistryDiff, previousTotal: number | null, nextTotal: number, cap = 200): string {
  const list = (rows: RegistryDiff['added']) =>
    rows.slice(0, cap).map((r) => `- \`${r.id}\` ${r.title}`).join('\n') +
    (rows.length > cap ? `\n- … and ${rows.length - cap} more` : '')
  return [
    '# Registry refresh: changes',
    '',
    `Total: ${previousTotal ?? 'none'} → ${nextTotal} datasets. Added ${diff.added.length}, removed ${diff.removed.length}.`,
    '',
    `## Added (${diff.added.length})`, '', diff.added.length ? list(diff.added) : '_none_', '',
    `## Removed (${diff.removed.length})`, '', diff.removed.length ? list(diff.removed) : '_none_', '',
  ].join('\n')
}
