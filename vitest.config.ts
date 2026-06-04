import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Resolve SvelteKit's virtual env module to a test stub so the sveltekit
    // adapter can be exercised outside a SvelteKit build.
    alias: {
      '$env/dynamic/private': new URL('./test/fixtures/svelte-env.ts', import.meta.url).pathname,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts runs main() on import, so it can't be imported for unit tests
      // without a refactor; it is covered by the npm-pack and manual smoke tests.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'text-summary'],
      // Floors set a few points below current (stmts 89 / branch 81 / func 94 /
      // lines 92) so the gate catches a real coverage regression on the gate code.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 90,
        lines: 88,
      },
    },
  },
})
