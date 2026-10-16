/**
 * Requests from the interface to the map, which owns dialogs and a file input the sidebar and the
 * command palette cannot reach. One typed event on `window` instead of a ref passed through three
 * components. The listener is MapPanel.
 */

export type MapAction = 'screenshot' | 'coordinates' | 'drawing-panel' | 'import' | 'terrain' | 'locate-details'

const EVENT = 'erdfeld:map-action'

export function requestMapAction(action: MapAction): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<MapAction>(EVENT, { detail: action }))
}

/** Subscribe to map actions; returns the unsubscribe function. */
export function onMapAction(handler: (action: MapAction) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<MapAction>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
