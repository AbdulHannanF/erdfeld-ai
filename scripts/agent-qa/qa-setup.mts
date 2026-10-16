/**
 * Next.js loads `.env` for us in the app; vitest does not. The live tools read
 * endpoints and keys straight off process.env, so without this every probe would
 * silently test the *default* endpoint rather than this deployment's — a false
 * green. Existing env wins, so CI/CLI overrides still work.
 */
import fs from 'fs'
import path from 'path'

for (const file of ['.env.local', '.env']) {
  const p = path.resolve(process.cwd(), file)
  if (!fs.existsSync(p)) continue
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
