/** Early layer emission: a tool draws its layer the moment it can, before its statistics finish.
 *
 *  The tool emits `layer_preview` through `ctx.emit`; the agent route turns it into a provisional
 *  `layer` event (see `src/lib/layer-event.ts`) and the tool's final layer, with the same id,
 *  replaces it on the map. Without an emitter (quick layers, tests) it does nothing.
 */

import { mark } from './timings'
import type { EmitFn, ResultLayer } from './types'

/** Event name the tool emits; nothing else listens for it. */
export const LAYER_PREVIEW_EVENT = 'layer_preview'

export function emitPreviewLayer(emit: EmitFn | undefined, layer: ResultLayer | null | undefined): void {
  if (!emit || !layer) return
  mark('first_layer')
  emit(LAYER_PREVIEW_EVENT, { layer })
}
