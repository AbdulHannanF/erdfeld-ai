/** Production configuration checks, run at server start (src/instrumentation.ts) and reported by
 *  GET /api/health. Only active when NODE_ENV=production; dev and tests are unaffected.
 *
 *  - `fatal`: the server must not start (the stub AI provider fabricates answers; it is test-only).
 *    The one exception is the browser e2e suite, which drives the production standalone server with
 *    the stub: it sets a second, explicit flag, `E2E_ALLOW_STUB_IN_PRODUCTION=1` (Playwright's
 *    webServer does; no deployment ever does). `AGENT_ALLOW_STUB=1` alone is still refused.
 *  - `errors`: the server runs but something is wrong enough to log loudly and mark /api/health
 *    `degraded`. Failing closed here would also take down a working demo, so the operator is told
 *    instead:
 *      - no EVIDENCE_SIGNING_KEY: each instance signs bundles with its own ephemeral key, so a
 *        bundle cannot be checked after a restart or on another instance. Bundles do say so.
 *      - GitHub sign-in configured without NEXTAUTH_SECRET: next-auth refuses every request.
 *        (Without a sign-in provider the per-process fallback secret signs nothing, so it is fine.)
 */

export interface ConfigProblems {
  fatal: string[]
  errors: string[]
}

export function productionConfigProblems(env: Record<string, string | undefined> = process.env): ConfigProblems {
  const problems: ConfigProblems = { fatal: [], errors: [] }
  if (env.NODE_ENV !== 'production') return problems
  if (env.AGENT_ALLOW_STUB === '1' && env.E2E_ALLOW_STUB_IN_PRODUCTION !== '1') {
    problems.fatal.push('AGENT_ALLOW_STUB=1 is set in production: the stub AI provider is test-only and must never serve users. (The e2e suite alone sets E2E_ALLOW_STUB_IN_PRODUCTION=1 as well.)')
  }
  if (!env.EVIDENCE_SIGNING_KEY?.trim()) {
    problems.errors.push('EVIDENCE_SIGNING_KEY is unset: every instance signs evidence bundles with its own ephemeral key, which cannot be verified later.')
  }
  if (env.GITHUB_ID?.trim() && env.GITHUB_SECRET?.trim() && !env.NEXTAUTH_SECRET?.trim()) {
    problems.errors.push('GitHub sign-in is configured but NEXTAUTH_SECRET is unset: sign-in will fail.')
  }
  return problems
}

/** Throws on a fatal problem; returns the non-fatal ones for the caller to log. */
export function assertProductionConfig(env: Record<string, string | undefined> = process.env): string[] {
  const { fatal, errors } = productionConfigProblems(env)
  if (fatal.length > 0) throw new Error(`Refusing to start: ${fatal.join(' ')}`)
  return errors
}
