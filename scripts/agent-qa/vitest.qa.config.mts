import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * QA-sweep config — deliberately SEPARATE from vitest.config.ts.
 *
 * The normal suite is hermetic (mocked fetch, no network). This one is the
 * opposite: it runs the real tool code against real upstream endpoints, so it
 * must never be picked up by `npm test`. Hence its own `include` and its own
 * file, run explicitly with `--config`.
 */
export default defineConfig({
  test: {
    include: ['scripts/agent-qa/**/*.qa.ts'],
    environment: 'node',
    css: false,
    // A live tool sweep across 36 upstreams is slow by nature; no per-test timeout
    // pressure, the runner enforces its own per-probe budget instead.
    testTimeout: 60 * 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    setupFiles: ['scripts/agent-qa/qa-setup.mts'],
  },
  css: { postcss: { plugins: [] } },
  resolve: { alias: { '@': path.resolve(process.cwd(), './src') } },
})
