import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_KEY_MAP,
  STORAGE_KEYS,
  migrateLegacyStorage,
  readJson,
  readStorage,
  removeStorage,
  resetStorageMigrationForTests,
  writeJson,
} from '../storage'

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe('migrateLegacyStorage', () => {
  it('copies every legacy key to its erdfeld name, owner token included', () => {
    const s = fakeStorage(Object.fromEntries(LEGACY_KEY_MAP.map(([legacy], i) => [legacy, `v${i}`])))
    migrateLegacyStorage(s)
    LEGACY_KEY_MAP.forEach(([legacy, current], i) => {
      expect(s.getItem(current)).toBe(`v${i}`)
      expect(s.getItem(legacy)).toBe(`v${i}`) // left in place for a rollback
    })
    expect(s.getItem(STORAGE_KEYS.ownerToken)).toBe(`v${LEGACY_KEY_MAP.findIndex(([, c]) => c === STORAGE_KEYS.ownerToken)}`)
  })

  it('names the keys the task lists', () => {
    expect(LEGACY_KEY_MAP.map(([l]) => l).sort()).toEqual(
      [
        'geoagent-settings', 'geoagent-aoi', 'geoagent-chat-history', 'geoagent-pinned-messages',
        'geoagent-recent-commands', 'geoagent-compare-seen', 'geoagent-onboarding-completed',
        'geoagent-owner-token', 'react-resizable-panels:geoagent-layout',
      ].sort(),
    )
  })

  it('never overwrites a key that already exists under the new name', () => {
    const s = fakeStorage({ 'geoagent-owner-token': 'old', [STORAGE_KEYS.ownerToken]: 'new' })
    migrateLegacyStorage(s)
    expect(s.getItem(STORAGE_KEYS.ownerToken)).toBe('new')
  })

  it('runs once: a key cleared afterwards is not resurrected from the old one', () => {
    const s = fakeStorage({ 'geoagent-aoi': '{"geometry":{}}' })
    migrateLegacyStorage(s)
    s.removeItem(STORAGE_KEYS.aoi)
    migrateLegacyStorage(s)
    expect(s.getItem(STORAGE_KEYS.aoi)).toBeNull()
  })

  it('does nothing harmful on a fresh browser', () => {
    const s = fakeStorage()
    migrateLegacyStorage(s)
    expect([...s.m.keys()]).toEqual(['erdfeld-storage-migrated'])
  })
})

describe('storage accessors', () => {
  beforeEach(() => resetStorageMigrationForTests())
  afterEach(() => vi.unstubAllGlobals())

  it('migrates on first use, so the first read already sees the old owner token', () => {
    const s = fakeStorage({ 'geoagent-owner-token': 'tok-123' })
    vi.stubGlobal('window', { localStorage: s })
    expect(readStorage(STORAGE_KEYS.ownerToken)).toBe('tok-123')
  })

  it('round-trips JSON and falls back on bad JSON', () => {
    const s = fakeStorage({ [STORAGE_KEYS.settings]: '{oops' })
    vi.stubGlobal('window', { localStorage: s })
    expect(readJson(STORAGE_KEYS.settings, { a: 1 })).toEqual({ a: 1 })
    expect(writeJson(STORAGE_KEYS.settings, { b: 2 })).toBe(true)
    expect(readJson(STORAGE_KEYS.settings, null)).toEqual({ b: 2 })
    removeStorage(STORAGE_KEYS.settings)
    expect(readStorage(STORAGE_KEYS.settings)).toBeNull()
  })

  it('is inert on the server and when storage throws', () => {
    expect(readStorage(STORAGE_KEYS.aoi)).toBeNull()
    expect(writeJson(STORAGE_KEYS.aoi, {})).toBe(false)
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('blocked')
      },
    })
    expect(readStorage(STORAGE_KEYS.aoi)).toBeNull()
    expect(writeJson(STORAGE_KEYS.aoi, {})).toBe(false)
  })
})
