/** Entry point for running an operation by name. The dispatcher switch that lived here is gone:
 *  every tool is a registered operation (`engine/ops/*.ts`) and every run goes through the one
 *  executor, which validates before and after and returns a `GeoResult`. */

import type { GeoResult } from '@/lib/geo-result'

import { runOperation } from '../engine/execute'
import type { ModelRegistry } from '../lib/inference/model-registry'
import type { EmitFn, PointFocus, ResultStore } from '../lib/types'
import type { RequestLlmConfig } from '../lib/vision/vlm'

export function executeTool(
  toolName: string,
  aoi: any,
  args: Record<string, any>,
  emit?: EmitFn,
  focus?: PointFocus,
  models?: ModelRegistry,
  llm?: RequestLlmConfig,
  results?: ResultStore,
): Promise<GeoResult> {
  return runOperation(toolName, args, { aoi, emit, focus, models, llm, results })
}
