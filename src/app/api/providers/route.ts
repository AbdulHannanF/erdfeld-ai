/** GET /api/providers — which AI providers this server can run without a browser-supplied key
 *  (AI-02). Reports names and default models only; a key never leaves the server. */

import { providersStatus } from '../agent/lib/providers'

export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(providersStatus(), { headers: { 'Cache-Control': 'no-store' } })
}
