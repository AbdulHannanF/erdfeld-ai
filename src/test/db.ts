/** Test helper: a real PostgreSQL schema per test file.
 *
 *  Database tests run against the server named by DATABASE_URL_TEST (see scripts/dev-db.sh; CI
 *  provides a `postgres:16` service). Each file gets its own schema, `test_<random>`, built by the
 *  real migrations (`prisma migrate deploy`), so the tables are the ones production has. The
 *  schema is dropped afterwards. Without DATABASE_URL_TEST the suites are skipped, loudly.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { describe } from 'vitest'

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST

if (!TEST_DATABASE_URL) {
  console.warn('[db tests] SKIPPED: DATABASE_URL_TEST is not set. Start a cluster with scripts/dev-db.sh and set DATABASE_URL_TEST to run them.')
}

/** `describe` when a test database is configured, otherwise a skipped suite. */
export const describeDb: typeof describe = (TEST_DATABASE_URL ? describe : describe.skip) as typeof describe

export interface TestDb {
  url: string
  schema: string
  prisma: PrismaClient
  drop(): Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error('DATABASE_URL_TEST is not set')
  const schema = `test_${randomBytes(6).toString('hex')}`
  const u = new URL(TEST_DATABASE_URL)
  u.searchParams.set('schema', schema)
  const url = u.toString()
  // run the prisma CLI through node: `npx` is a .cmd shim on Windows and cannot be spawned directly
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' })
  const prisma = new PrismaClient({ datasourceUrl: url })
  return {
    url,
    schema,
    prisma,
    async drop() {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await prisma.$disconnect()
    },
  }
}
