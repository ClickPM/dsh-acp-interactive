import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The official ACP specs are staged under `.harness-tests` at their real
 * monorepo-relative paths, so their own `../src/...` imports point at the staged
 * package rather than at this repository. Redirecting that one specifier prefix
 * runs the official assertions against this repository's source while leaving
 * cross-package fixture imports to resolve normally inside the staged tree.
 */
export default defineConfig({
  resolve: {
    alias: [{
      find: /^\.\.\/src\//,
      replacement: fileURLToPath(new URL('./src/', import.meta.url)),
    }],
  },
  test: {
    environment: 'node',
    // Only the official ACP package's specs are the compatibility contract.
    // Other staged packages contribute fixtures those specs import; their own
    // suites target their own internals and are not run here.
    include: ['.harness-tests/packages/acp/*/tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    isolate: true,
    pool: 'forks',
  },
})
