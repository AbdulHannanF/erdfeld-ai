/** rest reader: curated REST entries are routed to the GeoAgent tool that already reads that
 *  service, and its result is returned untouched. Entries with no wired tool say so. */

import type { DatasetEntry } from '../types'
import { REST_TOOLS } from './routing'
import { weatherVariablesFor } from '../../../tools/climate'
import { authRequiredResult, authToken, declaredExtent, honest } from './common'
import type { ReadOpts, ReaderAoi, ReadResult } from './types'

export async function readRest(entry: DatasetEntry, aoi: ReaderAoi, opts: ReadOpts): Promise<ReadResult> {
  let tool = REST_TOOLS[entry.id]
  if (tool) {
    if (!opts.runTool) {
      return honest(entry, 'error', { headline: 'Cannot route to the dedicated tool', body: ['No tool dispatcher was supplied to the reader.'] })
    }
    // A rainfall climatology only when no period was asked for; a dated question is answered from the daily archive.
    if (entry.id === 'open-meteo:era5-archive' && /precip|rain|snow/i.test(opts.variable ?? '') && !(opts.start || opts.end || opts.date)) tool = 'fetch_precipitation_history'
    // The dataset call's own period and variable go to the tool: ignoring them returned the trailing 12 months
    // under an `ok` status for a question about July 2023.
    const args: Record<string, any> = {}
    if (opts.start) args.start = opts.start
    if (opts.end) args.end = opts.end
    if (tool === 'fetch_weather_history') {
      const vars = weatherVariablesFor(opts.variable)
      if (vars) args.variables = vars
      if (opts.date && !opts.start && !opts.end) { args.start = opts.date; args.end = opts.date }
    }
    const out = await opts.runTool(tool, args)
    return {
      status: 'ok',
      summary: `_Read through GeoAgent's \`${tool}\` tool for ${entry.title}._\n\n${out.summary}`,
      stats: null,
      summary_data: { ...(out.summary_data ?? {}), read: 'ok', dataset: entry.id, routed_to: tool },
      provenance: out.layer?.provenance ?? null,
      coverage: { verdict: 'unknown', declared: declaredExtent(entry), found: `answered by ${tool}` },
      passthrough: out,
    }
  }

  const need = entry.access.requires_auth
  if (need && !authToken(need, entry.source).have) {
    return authRequiredResult(entry, need, '', [`REST endpoint: ${entry.access.url}. Even with the credential, GeoAgent has no AOI reader for this endpoint yet.`])
  }
  return honest(entry, 'unavailable', {
    headline: `No in-app reader for "${entry.title}" yet`,
    body: [
      `This is a ${entry.access.kind} endpoint (${entry.access.url}) that GeoAgent does not wrap: ` +
      `${entry.access.kind === 'tiles' ? 'it serves pre-rendered map tiles, not analysis values' : 'its API needs a dedicated client'}.`,
      entry.access.notes,
    ].filter(Boolean),
    needs: 'dedicated-client',
  })
}
