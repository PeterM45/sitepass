// Smoke-test the built package surface, because the unit tests import src/ and
// would ship packaging regressions green. Stage 1 imports every dist entry by
// file path in both formats and runs the CLI (catches tsup config and ESM/CJS
// interop breakage). Stage 2 installs the packed tarball into a throwaway
// consumer project and imports every public subpath by its package specifier
// in both formats — resolving through the exports map the way consumers
// actually do — then runs a minimal gate() call through the installed package.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dist = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url))
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

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

// Stage 2. The check script is generated once per format: `load` renders the
// loader expression (dynamic import vs require — `await` is harmless on the
// synchronous require result).
const specifiers = entries.map(([name, expected, hostResolved]) => [
  name === 'core' ? 'sitepass' : `sitepass/${name}`,
  expected,
  hostResolved ?? null,
])

const consumerCheck = (load) => `const entries = ${JSON.stringify(specifiers)}
const tolerated = (error, hostResolved) => {
  if (hostResolved === null) return false
  const message = String(error?.message ?? error)
  return message.includes(hostResolved) || message.includes("'" + hostResolved.split('/')[0] + "'")
}
async function main() {
  for (const [specifier, expected, hostResolved] of entries) {
    try {
      const mod = await ${load('specifier')}
      if (typeof mod[expected] !== 'function') {
        throw new Error(specifier + ' does not export function ' + expected)
      }
    } catch (error) {
      if (!tolerated(error, hostResolved)) throw error
    }
  }
  // A real call through the installed package: an anonymous request to a
  // configured gate must yield the 401 login page.
  const { createGate } = await ${load("'sitepass'")}
  const gate = createGate({ password: 'smoke', secret: 'smoke-secret-0123456789abcdef' })
  const result = await gate.handle({ method: 'GET', path: '/' })
  if (result.type !== 'html' || result.status !== 401) {
    throw new Error('expected a 401 login page, got ' + JSON.stringify(result))
  }
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
`

const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8' })

const work = mkdtempSync(join(tmpdir(), 'sitepass-smoke-'))
try {
  // publish.yml passes the exact tarball it is about to publish. With no
  // argument, pack one here — --ignore-scripts so prepack's tsup doesn't
  // rebuild the dist that stage 1 just verified.
  const packArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', work]
  const packed = process.argv[2]
    ? resolve(process.argv[2])
    : join(work, JSON.parse(npm(packArgs, packageRoot))[0].filename)

  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  const manifest = JSON.stringify({ name: 'smoke-consumer', private: true })
  writeFileSync(join(consumer, 'package.json'), manifest)
  // --legacy-peer-deps skips auto-installing the optional framework peers; the
  // two imports that need a host (next/server, $env/dynamic/private) are
  // tolerated above, same as stage 1.
  npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', packed],
    consumer,
  )

  writeFileSync(
    join(consumer, 'check.mjs'),
    consumerCheck((expr) => `import(${expr})`),
  )
  writeFileSync(
    join(consumer, 'check.cjs'),
    consumerCheck((expr) => `require(${expr})`),
  )
  execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, stdio: 'inherit' })
  execFileSync(process.execPath, ['check.cjs'], { cwd: consumer, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(
  `smoke-dist: ${checked} dist entries and ${specifiers.length} packed subpaths OK in both formats, CLI runs`,
)
