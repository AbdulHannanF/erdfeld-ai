import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 3000)
const STANDALONE = path.join(__dirname, '.next', 'standalone')

/** The e2e server's database: DATABASE_URL_E2E, else DATABASE_URL_TEST, in its own `e2e` schema so
 *  it never touches development data or the per-run `test_*` schemas of the unit tests. */
function e2eDatabaseUrl(): string {
  const base = process.env.DATABASE_URL_E2E || process.env.DATABASE_URL_TEST
  if (!base) throw new Error('e2e needs a PostgreSQL server: set DATABASE_URL_TEST (see scripts/dev-db.sh)')
  const u = new URL(base)
  u.searchParams.set('schema', 'e2e')
  return u.toString()
}

// The sandbox ships a Chromium outside Playwright's cache; CI uses the installed browser.
const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium'

/**
 * Runs against the production standalone server, so `next build` and the
 * `.next/static` + `public` copy into `.next/standalone` must happen first
 * (see .github/workflows/ci.yml). AGENT_ALLOW_STUB=1 enables the offline stub LLM.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined,
      // WebGL for MapLibre on headless machines without a GPU
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: `npx prisma migrate deploy && node "${path.join(STANDALONE, 'server.js')}"`,  // the path is quoted: checkouts live in directories with spaces
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      AGENT_ALLOW_STUB: '1',
      // prod-checks refuses the stub in production unless this second flag says it is the e2e suite
      E2E_ALLOW_STUB_IN_PRODUCTION: '1',
      // the suite makes many agent/quick-layer calls from one address
      RATE_LIMIT_AGENT_MAX: '10000',
      RATE_LIMIT_QUICK_LAYER_MAX: '10000',
      DATABASE_URL: e2eDatabaseUrl(),
    },
  },
})
