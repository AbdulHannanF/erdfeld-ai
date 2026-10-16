/** Which registry auth kinds can this deployment satisfy right now?
 *
 *  Used to FLAG entries ("needs Earthdata login, not configured here"); an entry that
 *  needs auth is never hidden. The names match `readers/routing.ts` AUTH_ENV, which the
 *  stage-2 readers consult when they decide whether a gated dataset can be read.
 */

import type { AuthKind } from './types'
import { isGeeConfigured } from '../gee'

export function detectAvailableAuth(env: NodeJS.ProcessEnv = process.env): AuthKind[] {
  const have = (...names: string[]) => names.some((n) => !!env[n]?.trim())
  const out: AuthKind[] = []
  if (isGeeConfigured()) out.push('earthengine')
  if (have('EARTHDATA_TOKEN', 'EARTHDATA_USERNAME')) out.push('earthdata')
  if (have('CDSE_TOKEN', 'CDSE_USERNAME', 'COPERNICUS_USERNAME')) out.push('copernicus')
  if (have('OPENTOPO_API_KEY', 'OPENTOPOGRAPHY_API_KEY')) out.push('opentopography')
  if (have('FIRMS_MAP_KEY', 'GFW_API_KEY', 'OPENAQ_API_KEY')) out.push('api-key')
  return out
}
