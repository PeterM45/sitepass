#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { startProxy } from './proxy'

// Replaced with the package version by tsup at build time; 'dev' when the
// source is executed directly (tests).
declare const __SITEPASS_VERSION__: string | undefined
const VERSION = typeof __SITEPASS_VERSION__ === 'string' ? __SITEPASS_VERSION__ : 'dev'

const TARGETS = [
  'cloudflare',
  'netlify',
  'next',
  'astro',
  'sveltekit',
  'express',
  'hono',
  'bun',
] as const
type Target = (typeof TARGETS)[number]

// Every flag each command accepts; anything else is a hard error so a typo'd
// security flag (--public-paths, --bypass-token) can never be silently ignored.
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  init: ['target', 'password', 'env-file', 'help', 'version'],
  proxy: [
    'origin',
    'port',
    'env-file',
    'public-paths',
    'login-path',
    'cookie-name',
    'session-seconds',
    'bypass-token',
    'insecure-cookie',
    'help',
    'version',
  ],
  help: ['help', 'version'],
}

// Run only when executed as a script (the npm bin or `node dist/cli.js`), not
// when imported — which is what makes the helpers below unit-testable.
// realpath resolves the symlink npm creates in node_modules/.bin.
if (isMainModule()) main()

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

async function main() {
  const args = process.argv
    .slice(2)
    .map((arg) => (arg === '-h' ? '--help' : arg === '-v' ? '--version' : arg))
  const command = args[0]?.startsWith('--') ? undefined : args[0]
  const flags = parseFlags(command === undefined ? args : args.slice(1))

  try {
    // Help and version always win, before any command runs: `sitepass init
    // --help` must print usage, not start an interactive init.
    if (flags.version) {
      console.log(VERSION)
      return
    }
    if (flags.help || command === 'help' || command === undefined) {
      printHelp()
      return
    }
    if (command !== 'init' && command !== 'proxy') {
      console.error(`Unknown command: ${command}\n`)
      printHelp()
      process.exitCode = 1
      return
    }
    rejectUnknownFlags(command, flags)
    if (command === 'init') await runInit(flags)
    else runProxy(flags)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

async function runInit(flags: Flags) {
  const target = await resolveTarget(flags)
  const envPath = asString(flags['env-file']) ?? (target === 'cloudflare' ? '.dev.vars' : '.env')

  // Never clobber an existing secret: a regenerated one would invalidate every
  // live session. Keep the password the user already set, too.
  const existingSecret = readEnvValue(envPath, 'SITEPASS_SECRET')
  const existingPassword = readEnvValue(envPath, 'SITEPASS_PASSWORD')
  const secret = existingSecret || generateSecret()

  // The gate treats secrets under 16 chars as unconfigured (fail closed). A kept
  // short secret would silently 503 the whole site, so warn rather than hide it.
  if (existingSecret && existingSecret.length < 16) {
    console.warn(
      `Warning: the existing SITEPASS_SECRET is only ${existingSecret.length} characters; the gate needs at least 16 and will fail closed (503) until you set a longer one.`,
    )
  }

  let password = existingPassword || asString(flags.password) || ''
  if (!password && isInteractive()) {
    password = await prompt('Shared password (leave blank to set later): ')
  }

  upsertEnv(envPath, { SITEPASS_PASSWORD: password, SITEPASS_SECRET: secret })
  const ignored = ensureGitignored(envPath)

  console.log(`\nWrote ${envPath}`)
  console.log(`  SITEPASS_SECRET    ${existingSecret ? 'kept existing value' : 'generated'}`)
  console.log(`  SITEPASS_PASSWORD  ${password ? 'set' : 'empty, fill it in before deploying'}`)
  if (ignored === 'added') console.log(`\nAdded ${envPath} to .gitignore.`)
  console.log(
    `\nNever commit ${envPath}: SITEPASS_SECRET signs every session token, so leaking it lets anyone forge a login.`,
  )
  console.log(`\n${snippetFor(target)}`)
}

// Keep the signing secret out of version control. A committed SITEPASS_SECRET
// lets anyone forge a valid session token, so make sure the env file is ignored.
export function ensureGitignored(file: string): 'added' | 'present' | 'skipped' {
  const gitignorePath = '.gitignore'
  const hasGitignore = existsSync(gitignorePath)
  // Only manage .gitignore in a project that actually uses git.
  if (!(hasGitignore || existsSync('.git'))) return 'skipped'

  const current = hasGitignore ? readFileSync(gitignorePath, 'utf8') : ''
  const covered = current.split('\n').some((line) => {
    const entry = line.trim().replace(/^\//, '').replace(/\/$/, '')
    if (!entry || entry.startsWith('#')) return false
    return entry === file || (entry === '.env*' && file.startsWith('.env'))
  })
  if (covered) return 'present'

  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current
  writeFileSync(gitignorePath, `${prefix}${file}\n`)
  return 'added'
}

function runProxy(flags: Flags) {
  const origin = asString(flags.origin)
  if (!origin)
    throw new Error('sitepass proxy requires --origin <url>, e.g. --origin http://localhost:8080')
  const rawPort = asString(flags.port)
  const port = rawPort === undefined ? 8788 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${rawPort}": expected a number between 0 and 65535.`)
  }

  loadDotenv(asString(flags['env-file']) ?? '.env')
  const password = process.env.SITEPASS_PASSWORD ?? ''
  const secret = process.env.SITEPASS_SECRET ?? ''
  const missing = [!password && 'SITEPASS_PASSWORD', !secret && 'SITEPASS_SECRET'].filter(
    (name): name is string => typeof name === 'string',
  )
  if (missing.length > 0) {
    console.warn(
      `Warning: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set, so the gate fails closed (503). Run \`sitepass init\` first.`,
    )
  }

  const sessionSecondsFlag = asString(flags['session-seconds'])
  let sessionSeconds: number | undefined
  if (sessionSecondsFlag !== undefined) {
    sessionSeconds = Number(sessionSecondsFlag)
    if (!Number.isInteger(sessionSeconds) || sessionSeconds <= 0) {
      throw new Error(
        `Invalid --session-seconds "${sessionSecondsFlag}": expected a positive integer.`,
      )
    }
  }

  startProxy({
    origin,
    port,
    password,
    secret,
    publicPaths: asString(flags['public-paths'])
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    loginPath: asString(flags['login-path']),
    cookieName: asString(flags['cookie-name']),
    sessionSeconds,
    bypassToken: asString(flags['bypass-token']) ?? process.env.SITEPASS_BYPASS_TOKEN,
    // --insecure-cookie drops the Secure attribute for plain-HTTP (LAN) use;
    // without it, browsers reject the cookie and login silently loops.
    cookieSecure: flagEnabled(flags['insecure-cookie']) ? false : undefined,
  })
  console.log(`sitepass proxy listening on http://localhost:${port} -> ${origin}`)
}

async function resolveTarget(flags: Flags): Promise<Target> {
  const fromFlag = asString(flags.target)
  if (fromFlag) {
    if (!isTarget(fromFlag))
      throw new Error(`Unknown target "${fromFlag}". One of: ${TARGETS.join(', ')}`)
    return fromFlag
  }
  if (!isInteractive()) throw new Error(`Specify a target: --target <${TARGETS.join('|')}>`)

  console.log('Which target?')
  for (const [index, name] of TARGETS.entries()) console.log(`  ${index + 1}. ${name}`)
  const choice = TARGETS[Number(await prompt('Enter a number: ')) - 1]
  if (!choice) throw new Error('Invalid selection.')
  return choice
}

function generateSecret(): string {
  return randomBytes(32).toString('base64')
}

function snippetFor(target: Target): string {
  return SNIPPETS[target]
}

const SNIPPETS: Record<Target, string> = {
  cloudflare: `Create functions/_middleware.ts:

  import { gate } from 'sitepass/cloudflare'
  export const onRequest = gate()

Set SITEPASS_PASSWORD and SITEPASS_SECRET in your Pages project settings.
Local \`wrangler pages dev\` reads them from the .dev.vars just written.`,

  netlify: `Create netlify/edge-functions/gate.ts:

  import { gate, config } from 'sitepass/netlify'
  export default gate()
  export { config }

Set SITEPASS_PASSWORD and SITEPASS_SECRET in your Netlify site environment variables.`,

  next: `Create middleware.ts (Next 15 and earlier) or proxy.ts (Next 16+):

  import { gate } from 'sitepass/next'
  export const middleware = gate()   // Next 16+: export const proxy = gate()

  export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  }`,

  astro: `Create src/middleware.ts:

  import { gate } from 'sitepass/astro'
  export const onRequest = gate()

Only on-demand routes are gated. A fully static Astro site needs the Cloudflare
or Netlify adapter (or \`export const prerender = false\` with an adapter).`,

  sveltekit: `Create src/hooks.server.ts:

  import { gate } from 'sitepass/sveltekit'
  export const handle = gate()`,

  express: `In your server file, before your routes:

  import { gate } from 'sitepass/express'
  app.use(gate())`,

  hono: `On your Hono app, before your routes:

  import { gate } from 'sitepass/hono'
  app.use(gate())`,

  bun: `Wrap your fetch handler:

  import { gate } from 'sitepass/bun'
  Bun.serve({ fetch: gate(myHandler) })`,
}

function printHelp() {
  console.log(`sitepass ${VERSION}: one shared password in front of any web app

Usage:
  sitepass init  [--target <name>] [--password <pw>] [--env-file <path>]
  sitepass proxy --origin <url> [--port <n>] [--env-file <path>]
                 [--public-paths <a,b>] [--login-path <path>]
                 [--cookie-name <name>] [--session-seconds <n>]
                 [--bypass-token <token>] [--insecure-cookie]

init   generate a secret, write the env file, and print the wiring snippet
proxy  run a gating reverse proxy in front of an existing origin

The proxy reads SITEPASS_PASSWORD, SITEPASS_SECRET, and SITEPASS_BYPASS_TOKEN
from the environment (and the --env-file, default .env). --insecure-cookie
drops the cookie's Secure attribute for plain-HTTP (LAN) origins.

Targets: ${TARGETS.join(', ')}`)
}

// --- small helpers ---

type Flags = Record<string, string | boolean>

export function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg?.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      flags[arg.slice(2)] = next
      i++
    } else {
      flags[arg.slice(2)] = true
    }
  }
  return flags
}

export function rejectUnknownFlags(command: string, flags: Flags) {
  const known = KNOWN_FLAGS[command] ?? []
  const unknown = Object.keys(flags).filter((name) => !known.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag${unknown.length > 1 ? 's' : ''} for ${command}: ${unknown
        .map((name) => `--${name}`)
        .join(', ')}. Known: ${known.map((name) => `--${name}`).join(', ')}`,
    )
  }
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// A boolean flag is enabled by its bare form (--insecure-cookie) or an explicit
// truthy value (--insecure-cookie=true); an explicit =false disables it.
export function flagEnabled(value: string | boolean | undefined): boolean {
  if (value === true) return true
  if (typeof value === 'string') return value === '' || value === 'true' || value === '1'
  return false
}

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value)
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY)
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim()
  }
  return undefined
}

// Update or append the given keys, preserving every other line in the file.
export function upsertEnv(path: string, updates: Record<string, string>) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  // Drop trailing blank lines so an appended key lands right after the last
  // entry instead of leaving an empty line mid-file (the final newline is
  // re-added on write).
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`
    const index = lines.findIndex((existing) => existing.startsWith(`${key}=`))
    if (index === -1) lines.push(line)
    else lines[index] = line
  }
  // The file holds SITEPASS_SECRET in plaintext, so keep it owner-only (0600).
  // `mode` on writeFileSync only applies when the file is created, so chmod the
  // path explicitly to also tighten a pre-existing, looser env file.
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort: some filesystems (e.g. Windows, mounted volumes) don't support
    // POSIX modes. The mode hint above still applies on create where it can.
  }
}

// A dependency-free .env loader. process.loadEnvFile exists only on Node
// >= 20.12 while engines allow >= 20, so parse the file directly: KEY=VALUE
// lines, # comments, optional single/double quotes, real env always wins.
export function loadDotenv(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    if (key !== '' && !(key in process.env)) process.env[key] = value
  }
}
