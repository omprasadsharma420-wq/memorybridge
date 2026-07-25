import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/performance/**/*.benchmark.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
    fileParallelism: false
  }
})
