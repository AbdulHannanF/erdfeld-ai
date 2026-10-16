import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts', 'eval/**/*.test.ts'],
    environment: 'node',
    css: false,
  },
  // Disable PostCSS picking up the Next.js tailwind config (vitest only loads node modules here)
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
