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
  'hono/factory',
  'express',
  /^astro:/,
  /^\$env\//,
]

export default defineConfig({
  entry: ['src/*.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'node',
  dts: true,
  clean: true,
  splitting: true,
  treeshake: true,
  sourcemap: false,
  external,
})
