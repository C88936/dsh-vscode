import { defineConfig } from 'vitest/config'

/**
 * Extension unit tests: the host helpers that do not need VS Code or a running
 * DSH tree.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
