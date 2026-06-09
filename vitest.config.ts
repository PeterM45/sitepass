import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Resolve SvelteKit's virtual env module to a test stub so the sveltekit
    // adapter can be exercised outside a SvelteKit build. fileURLToPath (not
    // URL.pathname) so the alias also resolves on Windows checkouts.
    alias: {
      '$env/dynamic/private': fileURLToPath(
        new URL('./test/fixtures/svelte-env.ts', import.meta.url),
      ),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI's pure helpers are unit-tested (test/cli.test.ts) and the built
      // binary is executed in CI (scripts/smoke-dist.mjs), but its interactive
      // flows (TTY prompts, proxy startup) would need a pty harness, so the
      // file stays outside the coverage gate.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'text-summary'],
      // Floors set a few points below current (stmts 94 / branch 82 / func 97 /
      // lines 97) so the gate catches a real coverage regression on the gate code.
      thresholds: {
        statements: 90,
        branches: 79,
        functions: 93,
        lines: 93,
      },
    },
  },
})
