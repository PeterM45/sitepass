import { defineConfig } from 'tsup'

// Keep every framework/host import out of the bundle so a consumer who installs
// sitepass for one target never pulls another's runtime. `astro:middleware` and
// `$env/dynamic/private` are virtual modules resolved by the host build, so they
// must be externalized too (the regexes cover their whole families).
const external = [
  'next',
  'next/server',
  'astro:middleware',
  '@sveltejs/kit',
  '$env/dynamic/private',
  'hono',
  'express',
  /^astro:/,
  /^\$env\//,
]

// Public entries only: src/web.ts and src/node-body.ts are internal modules that
// land in the shared chunks, so they must not become their own (unreachable)
// dist entries.
const entries = [
  'src/core.ts',
  'src/cloudflare.ts',
  'src/netlify.ts',
  'src/next.ts',
  'src/astro.ts',
  'src/sveltekit.ts',
  'src/express.ts',
  'src/hono.ts',
  'src/bun.ts',
  'src/proxy.ts',
]

export default defineConfig([
  {
    entry: entries,
    format: ['esm', 'cjs'],
    target: 'es2022',
    platform: 'node',
    dts: true,
    clean: true,
    splitting: true,
    treeshake: true,
    sourcemap: false,
    external,
  },
  {
    // The CLI is a bin, not an importable module: ESM only, and no declaration
    // files (its dts output was a shebang-only stub that shipped as junk).
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    dts: false,
    clean: false,
    sourcemap: false,
    external,
  },
])
