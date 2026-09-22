import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/mock-provider/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['tests/unit/global-setup.ts'],
    coverage: { provider: 'v8', include: ['src/main/**', 'src/shared/**'] },
  },
})
