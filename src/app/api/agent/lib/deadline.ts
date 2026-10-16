/** Deadlines for work that can hang: wait for a promise only until a signal aborts.
 *
 *  An abort signal only helps when the work listens to it, and not every library does. These two
 *  helpers make the caller's wait end anyway, with a message that says why, so a slow upstream
 *  becomes a reported failure instead of a stuck run. */

import { withRequestAbortSignal } from './cache'

/** Resolve with `work`, or reject as soon as `signal` aborts. The abandoned work is left to finish
 *  in the background; its late rejection is swallowed. `limitMs` only words the timeout message. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, what: string, limitMs: number): Promise<T> {
  work.catch(() => {})
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(new Error(
      signal.reason?.name === 'TimeoutError'
        ? `${what} did not finish within its ${Math.round(limitMs / 1000)} s limit`
        : `${what} was stopped because the run ended or its time budget ran out`,
    ))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([work, stopped])
}

/** Run `fn` for at most `ms` (and no longer than `parent`). Fetches made inside carry the deadline
 *  through the request-scoped signal. */
export function withDeadline<T>(ms: number, parent: AbortSignal | undefined, what: string, fn: () => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(ms)
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
  return abortable(withRequestAbortSignal(signal, fn), signal, what, ms)
}
