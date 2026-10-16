/** Debug log gate (P7.2: now a thin pino wrapper).
 *
 *  `debugLog(...args)` preserves the original variadic call sites (e.g.
 *  `debugLog('cache hit:', source, key)`) but routes through the structured
 *  logger at `debug` level instead of `console.log`. It only emits when the
 *  logger's level allows `debug` — i.e. `DEBUG_AGENT=1` or `LOG_LEVEL=debug`,
 *  exactly as before. Args are joined into the message so multi-arg calls
 *  keep working unchanged. */

import { getLogger } from './logger'

const log = getLogger('debug')

function toMessage(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

export function debugLog(...args: unknown[]): void {
  if (!log.isLevelEnabled('debug')) return
  log.debug(toMessage(args))
}
