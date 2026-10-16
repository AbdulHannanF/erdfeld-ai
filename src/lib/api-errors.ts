/** What a client shows for a failed API call (no zod, so client bundles stay free of the schemas).
 *  Understands the `invalid_request` shape from `lib/api-schemas.ts`, `rate_limited` and plain errors. */

/** The message a client shows for a failed API call, whatever shape the route answered in. */
export function apiErrorMessage(body: unknown, fallback: string): string {
  const b = body as { error?: unknown; issues?: Array<{ path?: string; message?: string }>; message?: unknown } | null
  if (b?.error === 'invalid_request' && b.issues?.length) {
    return b.issues.slice(0, 3).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
  }
  if (typeof b?.message === 'string' && b.message) return b.message
  return typeof b?.error === 'string' && b.error ? b.error : fallback
}
