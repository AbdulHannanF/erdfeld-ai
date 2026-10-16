/** P7.2 — structured logging via pino (the single logger for the API surface).
 *
 *  Use `getLogger(scope)` to get a child logger tagged with a `scope` field, e.g.
 *  `const log = getLogger('tools/satellite')`. Levels: `debug` (gated — see below),
 *  `info`, `warn`, `error`.
 *
 *  Level resolution:
 *    - `LOG_LEVEL` env wins if set (`trace|debug|info|warn|error|fatal|silent`).
 *    - else `DEBUG_AGENT=1` → `debug` (preserves the old verbose-payload behavior).
 *    - else `info`.
 *
 *  Output is line-delimited JSON (production-correct, log-aggregator friendly). Set
 *  `LOG_PRETTY=1` in dev for the human-readable pino-pretty transport — guarded in a
 *  try/catch because worker-thread transports can fail under some bundlers; on failure
 *  we silently fall back to JSON rather than crash the route.
 */

import pino, { type Logger } from 'pino'

/** Fields that can carry a credential; pino replaces them with "[redacted]" wherever they appear
 *  (top level or one object deep), so a config or header object logged by mistake leaks nothing. */
export const LOG_REDACT_PATHS = [
  'apiKey', 'aiApiKey', 'api_key', 'authorization', 'Authorization', '["x-api-key"]', 'token', 'secret', 'password',
  '*.apiKey', '*.aiApiKey', '*.api_key', '*.authorization', '*.Authorization', '*["x-api-key"]', '*.token', '*.secret', '*.password',
  'headers.authorization', 'headers["x-api-key"]', 'headers["x-owner-token"]',
]
export const LOG_REDACT = { paths: LOG_REDACT_PATHS, censor: '[redacted]' }

function resolveLevel(): string {
  const explicit = process.env.LOG_LEVEL?.trim()
  if (explicit) return explicit
  if (process.env.DEBUG_AGENT) return 'debug'
  return 'info'
}

function buildBaseLogger(): Logger {
  const level = resolveLevel()
  const base = { app: 'geoagent' as const }

  if (process.env.LOG_PRETTY === '1') {
    try {
      return pino({
        level,
        base,
        redact: LOG_REDACT,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' },
        },
      })
    } catch {
      // Worker transport unavailable (bundler/edge) — fall through to plain JSON.
    }
  }

  return pino({ level, base, redact: LOG_REDACT })
}

// One process-wide base logger; scoped children are cheap.
const baseLogger: Logger = buildBaseLogger()

/** A scoped child logger. `scope` lands on every line as a field for easy filtering. */
export function getLogger(scope: string): Logger {
  return baseLogger.child({ scope })
}

/** The root logger — for the rare call site that doesn't have a natural scope. */
export const logger: Logger = baseLogger
