#!/usr/bin/env node
/**
 * P7.1 — zero-dependency staged-secret guard, run from the pre-commit hook.
 *
 * Two checks over what is *staged* (not the whole tree):
 *   1. Block committing a real env file (`.env`, `.env.local`, …). Only
 *      `*.example` templates are allowed.
 *   2. Scan added lines for high-signal secret patterns (provider API keys,
 *      AWS keys, private-key headers). Patterns are deliberately specific so
 *      this never false-positives on lockfile hashes or env-var *names*.
 *
 * This is the offline fallback. If `gitleaks` is installed the hook also runs
 * `gitleaks protect --staged` for full coverage; CI runs gitleaks over history.
 *
 * `--all` (CI) scans every tracked file instead of the staged diff.
 *
 * Exit 0 = clean, 1 = a secret (or env file) is staged / tracked.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Staged, added/copied/modified file paths. */
function stagedFiles() {
  const out = git('diff --cached --name-only --diff-filter=ACM')
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

// A real env file: `.env`, `.env.local`, `.env.production`, … but NOT a template.
const ENV_FILE_RE = /(^|\/)\.env(\.[^/]+)?$/
const ENV_TEMPLATE_RE = /\.example$|\.sample$|\.template$/

const SECRET_PATTERNS = [
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
]

// Placeholder values that look key-ish but are obviously not real secrets.
const PLACEHOLDER_RE = /(your[_-]|example|placeholder|changeme|xxxxx|<[^>]+>|\.\.\.)/i

const ALL = process.argv.includes('--all')

/** All tracked, non-lockfile text files (CI mode). */
function trackedFiles() {
  return git('ls-files').split('\n').map((s) => s.trim()).filter((f) => f && !/(^|\/)(package-lock\.json|bun\.lock)$/.test(f))
}

/** Every line of every tracked file, as if it had just been added (CI mode). */
function trackedAsDiff() {
  const parts = []
  for (const f of trackedFiles()) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    if (text.includes('\0') || text.length > 2_000_000) continue
    parts.push(`+++ b/${f}`, ...text.split('\n').map((l) => '+' + l))
  }
  return parts.join('\n')
}

function main() {
  const files = ALL ? trackedFiles() : stagedFiles()
  const violations = []

  // 1. Real env files must never be staged.
  for (const f of files) {
    if (ENV_FILE_RE.test(f) && !ENV_TEMPLATE_RE.test(f)) {
      violations.push(`Staged env file "${f}" — env files are secrets and must stay gitignored. Use .env.example for templates.`)
    }
  }

  // 2. Scan added lines (the unified diff `+` side) for secret patterns.
  let diff = ''
  try {
    diff = ALL ? trackedAsDiff() : git('diff --cached -U0 --diff-filter=ACM')
  } catch {
    diff = ''
  }
  let currentFile = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const added = line.slice(1)
    if (PLACEHOLDER_RE.test(added)) continue
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(added)) {
        violations.push(`Possible ${name} in staged change to "${currentFile || 'unknown'}": ${added.trim().slice(0, 80)}`)
      }
    }
  }

  if (violations.length) {
    console.error('\n✖ Secret hygiene check failed (P7.1):\n')
    for (const v of violations) console.error('  • ' + v)
    console.error('\nUnstage the offending change, or move the value into a gitignored .env.')
    console.error('If this is a false positive, see .gitleaks.toml for the allowlist mechanism.\n')
    process.exit(1)
  }
}

main()
