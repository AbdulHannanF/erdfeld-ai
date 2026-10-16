/** One wording for "the request failed", so no tool can mistake an outage for an empty result.
 *
 *  A tool that catches a network/HTTP error and then reports "no scene found", "likely ocean"
 *  or "no data" is telling the user the world has no data when it was the connection that
 *  failed (Q-06). Use this for every catch-branch that ends in a user-facing summary; keep
 *  the "no data" wording for the case where a request SUCCEEDED and came back empty.
 */

/** Short reason from an unknown thrown value. */
export function errorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return msg.trim().slice(0, 160) || 'request failed'
}

const NOT_ABSENCE = 'This is a connectivity failure, not an absence of data'

/** Markdown sentence for a summary: names the service, the reason, and what it does NOT mean. */
export function fetchFailureNote(service: string, err?: unknown): string {
  return `**Could not reach ${service}** (${errorReason(err)}). ${NOT_ABSENCE} — retry shortly.`
}

/** True when a summary carries the standard failure note, so the executor can report the result
 *  as `failed` (an upstream could not be read) rather than as an empty answer. */
export function isFetchFailureSummary(summary: string): boolean {
  return summary.includes(NOT_ABSENCE)
}
