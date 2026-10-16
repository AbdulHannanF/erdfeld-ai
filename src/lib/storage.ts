/** The one place the app touches localStorage. Every persisted key is named here, and reads and
 *  writes go through these helpers so that:
 *   - storage that is blocked or full never throws into a component;
 *   - the rename from the GeoAgent-era `geoagent-*` keys to `erdfeld-*` is migrated once,
 *     whichever call touches storage first. The owner token matters most: it is the only handle
 *     to a person's saved projects, so losing it orphans their data. */

export const STORAGE_KEYS = {
  settings: 'erdfeld-settings',
  aoi: 'erdfeld-aoi',
  chatHistory: 'erdfeld-chat-history',
  pinnedMessages: 'erdfeld-pinned-messages',
  recentCommands: 'erdfeld-recent-commands',
  compareSeen: 'erdfeld-compare-seen',
  onboardingCompleted: 'erdfeld-onboarding-completed',
  ownerToken: 'erdfeld-owner-token',
  /** autoSaveId for the main react-resizable-panels group */
  layoutId: 'erdfeld-layout',
  /** Workspace sidebar: 'collapsed' or 'expanded' once the person has chosen; absent = follow the width */
  sidebar: 'erdfeld-sidebar',
  /** Basemap choice: 'auto' (follows the theme), 'dark', 'light', 'voyager' or 'satellite' */
  basemap: 'erdfeld-basemap',
  /** Terrain relief hillshade: 'on' (default) or 'off' */
  relief: 'erdfeld-relief',
  /** CRS for vector export, an EPSG code */
  exportCrs: 'erdfeld-export-crs',
  /** Batches this browser queued (tool runs and claim batches): id, label, where to open it */
  jobs: 'erdfeld-jobs',
  /** Evidence-ledger runs this browser started: id, question, time */
  runs: 'erdfeld-runs',
} as const

/** react-resizable-panels stores a group's sizes under this prefix plus its autoSaveId. */
const PANELS_PREFIX = 'react-resizable-panels:'

/** Pairs of [legacy key, new key]. A legacy value is copied only when the new key is empty. */
export const LEGACY_KEY_MAP: ReadonlyArray<readonly [string, string]> = [
  ['geoagent-settings', STORAGE_KEYS.settings],
  ['geoagent-aoi', STORAGE_KEYS.aoi],
  ['geoagent-chat-history', STORAGE_KEYS.chatHistory],
  ['geoagent-pinned-messages', STORAGE_KEYS.pinnedMessages],
  ['geoagent-recent-commands', STORAGE_KEYS.recentCommands],
  ['geoagent-compare-seen', STORAGE_KEYS.compareSeen],
  ['geoagent-onboarding-completed', STORAGE_KEYS.onboardingCompleted],
  ['geoagent-owner-token', STORAGE_KEYS.ownerToken],
  [`${PANELS_PREFIX}geoagent-layout`, `${PANELS_PREFIX}${STORAGE_KEYS.layoutId}`],
]

/** Set once the copy has run, so a key the user later clears is not resurrected from the old one. */
const MIGRATED_FLAG = 'erdfeld-storage-migrated'

/** Copy each legacy key to its new name when the new one is missing. Idempotent; the legacy keys
 *  are left in place so a rollback to the old build still finds its data. */
export function migrateLegacyStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  if (storage.getItem(MIGRATED_FLAG)) return
  for (const [legacy, current] of LEGACY_KEY_MAP) {
    if (storage.getItem(current) !== null) continue
    const value = storage.getItem(legacy)
    if (value !== null) storage.setItem(current, value)
  }
  storage.setItem(MIGRATED_FLAG, '1')
}

let migrationAttempted = false

/** localStorage, or null on the server and when the browser denies access. Runs the key
 *  migration the first time it is reached. */
function local(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    const s = window.localStorage
    if (!migrationAttempted) {
      migrationAttempted = true
      try {
        migrateLegacyStorage(s)
      } catch {
        // quota or a partial copy: the unmigrated keys are picked up on the next load
        s.removeItem(MIGRATED_FLAG)
      }
    }
    return s
  } catch {
    return null
  }
}

export function readStorage(key: string): string | null {
  try {
    return local()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Returns false when the write did not happen (blocked or over quota). */
export function writeStorage(key: string, value: string): boolean {
  try {
    const s = local()
    if (!s) return false
    s.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeStorage(key: string): void {
  try {
    local()?.removeItem(key)
  } catch {
    // nothing to remove if storage is unavailable
  }
}

/** Parsed JSON, or `fallback` when the key is absent or its value is not valid JSON. */
export function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  return writeStorage(key, JSON.stringify(value))
}

/** Test hook: forget that the migration ran in this page. */
export function resetStorageMigrationForTests(): void {
  migrationAttempted = false
}
