import { describe, expect, it } from 'vitest'
import { basemapChoice, basemapStyleId, DEFAULT_BASEMAP, initialBasemapStyleId } from '@/components/map/basemaps'
import { useUi } from '../useUi'

describe('the basemap a first visit meets', () => {
  it('is imagery, in either theme, until one is chosen', () => {
    expect(DEFAULT_BASEMAP).toBe('satellite')
    expect(basemapStyleId(basemapChoice(null), 'dark')).toBe('satellite')
    expect(basemapStyleId(basemapChoice(null), 'light')).toBe('satellite')
    expect(basemapChoice('not-a-basemap')).toBe('satellite')
    // the map's first style (no document here) and the store agree, so nothing swaps after load
    expect(initialBasemapStyleId()).toBe('satellite')
    expect(useUi.getState().basemap).toBe('satellite')
  })

  it('keeps a saved choice, and "auto" still follows the theme', () => {
    expect(basemapChoice('dark')).toBe('dark')
    expect(basemapStyleId(basemapChoice('auto'), 'dark')).toBe('dark')
    expect(basemapStyleId(basemapChoice('auto'), 'light')).toBe('light')
  })
})

describe('the inspector a first visit meets', () => {
  it('opens on Erdfeld (the assistant and its sample cases), not the toolbox', () => {
    expect(useUi.getState().inspectorTab).toBe('assistant')
  })
})

describe('the saved interface choices', () => {
  it('are marked read once hydrate runs, so nothing acts on the defaults before then', () => {
    expect(useUi.getState().hydrated).toBe(false)
    useUi.getState().hydrate()
    expect(useUi.getState().hydrated).toBe(true)
  })
})
