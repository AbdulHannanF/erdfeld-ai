/** MapLibre GL, with its web worker wired for the Next bundle.
 *
 *  MapLibre 6 ships an ES-module worker and finds it relative to its own `import.meta.url`.
 *  Bundled, that URL points into Next's chunk folder where no worker file exists, the worker
 *  fails to load and no map ever fires `load`. `new URL(…, import.meta.url)` makes the bundler
 *  emit the worker as an asset and hands us its real URL. Import MapLibre from here, not from
 *  'maplibre-gl', so the worker is configured before any map is created. */

import * as maplibregl from 'maplibre-gl'

if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href)
}

export * from 'maplibre-gl'
