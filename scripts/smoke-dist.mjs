// Smoke-test the built package surface: import every published dist entry in
// both formats, assert the expected export exists, and run the CLI. Catches
// packaging regressions (tsup config, exports map, ESM/CJS interop) that the
// unit tests — which import src/ — would ship to npm green.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dist = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url))

// [entry base name, expected export, host-resolved import]. Some adapters
// import modules that only resolve inside their host's build: SvelteKit's
// virtual $env/dynamic/private, and next/server (Next has no exports map, so
// bare-ESM Node can't resolve it; Next's bundler and CJS extension search
// can). For those, a resolution failure naming exactly that specifier is
// tolerated — it still proves the bundle parses and everything else resolves.
const entries = [
  ['core', 'createGate'],
  ['cloudflare', 'gate'],
  ['netlify', 'gate'],
  ['next', 'gate', 'next/server'],
  ['astro', 'gate'],
  ['sveltekit', 'gate', '$env/dynamic/private'],
  ['express', 'gate'],
  ['hono', 'gate'],
  ['bun', 'gate'],
  ['proxy', 'startProxy'],
]

let checked = 0
for (const [name, expected, hostResolved] of entries) {
  // Node names the full specifier in some resolver errors and only the bare
  // package name in others ("Cannot find package '$env'"), so accept either.
  const tolerated = (error) => {
    if (hostResolved === undefined) return false
    const message = String(error?.message ?? error)
    return message.includes(hostResolved) || message.includes(`'${hostResolved.split('/')[0]}'`)
  }

  try {
    const esm = await import(dist(`${name}.js`))
    if (typeof esm[expected] !== 'function') {
      throw new Error(`dist/${name}.js does not export function ${expected}`)
    }
  } catch (error) {
    if (!tolerated(error)) throw error
  }

  try {
    const cjs = require(dist(`${name}.cjs`))
    if (typeof cjs[expected] !== 'function') {
      throw new Error(`dist/${name}.cjs does not export function ${expected}`)
    }
  } catch (error) {
    if (!tolerated(error)) throw error
  }
  checked++
}

const help = execFileSync(process.execPath, [dist('cli.js'), 'help'], { encoding: 'utf8' })
if (!help.includes('sitepass')) {
  throw new Error('dist/cli.js help output looks wrong')
}

console.log(`smoke-dist: ${checked} entries OK in both formats, CLI runs`)
