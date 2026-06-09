#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { SNIPPETS, TARGETS, type Target } from './cli-snippets'
import { startProxy } from './proxy'

// Replaced with the package version by tsup at build time; 'dev' when the
// source is executed directly (tests).
declare const __SITEPASS_VERSION__: string | undefined
const VERSION = typeof __SITEPASS_VERSION__ === 'string' ? __SITEPASS_VERSION__ : 'dev'

// Every flag each command accepts; anything else is a hard error so a typo'd
// security flag (--public-paths, --bypass-token) can never be silently ignored.
// `help` needs no entry: main() prints usage before flag validation runs.
const KNOWN_FLAGS: Record<'init' | 'proxy', readonly string[]> = {
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
    'trust-proxy',
    'help',
    'version',
  ],
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

  try {
    const flags = parseFlags(command === undefined ? args : args.slice(1))
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
  // Common in monorepo subpackages, where .git lives at the repo root: the
  // secret-bearing file was NOT added to any ignore file, so say so.
  if (ignored === 'skipped') {
    console.log(
      `\nNo .gitignore or .git directory here, so nothing was updated: make sure ${envPath} is git-ignored in your repository.`,
    )
  }
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
  // "localhost:8080" is a valid URL whose protocol is "localhost:", so require
  // an http(s) scheme explicitly — otherwise the proxy starts and then 502s
  // every request instead of failing at startup.
  const originUrl = URL.canParse(origin) ? new URL(origin) : undefined
  if (!originUrl || (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:')) {
    throw new Error(`Invalid --origin "${origin}": expected a full URL like http://localhost:8080.`)
  }
  const rawPort = asString(flags.port)
  const port = rawPort === undefined ? 8788 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${rawPort}": expected a number between 0 and 65535.`)
  }

  // The implicit .env default may be absent, but a path the user typed must
  // exist — a typo'd --env-file would otherwise be silently ignored and the
  // gate would fail closed with a misleading "run sitepass init" hint.
  const envFile = asString(flags['env-file'])
  loadDotenv(envFile ?? '.env', envFile !== undefined)
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

  const server = startProxy({
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
    cookieSecure: flagEnabled('insecure-cookie', flags['insecure-cookie']) ? false : undefined,
    // --trust-proxy passes the front hop's X-Forwarded-* through to the origin
    // (for a TLS terminator in front of the proxy); only safe when clients
    // cannot reach the proxy directly, so it stays off by default.
    trustProxy: flagEnabled('trust-proxy', flags['trust-proxy']),
  })
  // Only announce success once the socket is actually bound, and surface a bind
  // failure (e.g. port in use) instead of a false banner followed by a crash.
  server.on('listening', () => {
    // --port 0 asks the OS for a free port, so report the one actually bound.
    const address = server.address()
    const bound = typeof address === 'object' && address !== null ? address.port : port
    console.log(`sitepass proxy listening on http://localhost:${bound} -> ${origin}`)
  })
  server.on('error', (error: NodeJS.ErrnoException) => {
    const detail = error.code === 'EADDRINUSE' ? ` (port ${port} is already in use)` : ''
    console.error(`sitepass proxy failed to start${detail}: ${error.message}`)
    process.exitCode = 1
  })
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

function printHelp() {
  console.log(`sitepass ${VERSION}: one shared password in front of any web app

Usage:
  sitepass init  [--target <name>] [--password <pw>] [--env-file <path>]
  sitepass proxy --origin <url> [--port <n>] [--env-file <path>]
                 [--public-paths <a,b>] [--login-path <path>]
                 [--cookie-name <name>] [--session-seconds <n>]
                 [--bypass-token <token>] [--insecure-cookie] [--trust-proxy]

init   generate a secret, write the env file, and print the wiring snippet
proxy  run a gating reverse proxy in front of an existing origin

The proxy reads SITEPASS_PASSWORD, SITEPASS_SECRET, and SITEPASS_BYPASS_TOKEN
from the environment (and the --env-file, default .env). --insecure-cookie
drops the cookie's Secure attribute for plain-HTTP (LAN) origins.
--trust-proxy passes the front hop's X-Forwarded-* through to the origin (for
a TLS terminator in front of the proxy); without it the proxy overwrites them
and always reports proto=http. Only use it when clients cannot reach the
proxy directly.

Note: Node pre-scans --env-file itself (Node >= 20.7), so when the file is
missing a \`node dist/cli.js\`-style invocation aborts with node's own error
before sitepass runs.

Targets: ${TARGETS.join(', ')}`)
}

// --- small helpers ---

type Flags = Record<string, string | boolean>

export function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    // Anything that is neither a --flag nor a value consumed by one is a hard
    // error, same as unknown flags: a single-dash typo of a security flag
    // (-public-paths, -insecure-cookie) must never be silently dropped.
    if (!arg.startsWith('--')) {
      throw new Error(
        arg.startsWith('-')
          ? `Unexpected argument "${arg}": flags use two dashes, e.g. -${arg}.`
          : `Unexpected argument "${arg}": values must follow a --flag (see sitepass --help).`,
      )
    }
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

export function rejectUnknownFlags(command: keyof typeof KNOWN_FLAGS, flags: Flags) {
  const known = KNOWN_FLAGS[command]
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
// truthy value (--insecure-cookie=true); an explicit =false disables it. Any
// other spelling (=yes, =TRUE, =on) is a hard error: silently treating it as
// false would leave Secure on the cookie and recreate the invisible login loop
// the flag exists to fix.
export function flagEnabled(name: string, value: string | boolean | undefined): boolean {
  if (typeof value !== 'string') return value === true
  if (value === '' || value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(
    `Invalid value "${value}" for --${name}: use --${name}, --${name}=true, or --${name}=false.`,
  )
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

// Parse one KEY=VALUE env line into [key, value], following dotenv's rules —
// the parser Next, Astro dev, and wrangler all use — so the password sitepass
// reads is the password the framework will read from the same file: a leading
// `export ` is ignored, an unquoted value ends at the first '#', quotes (', ",
// or \`) wrap a value that may then be followed by a comment, and \n/\r expand
// inside double quotes only. Returns null for blanks, comments, and
// non-assignments. Shared by readEnvValue/upsertEnv/loadDotenv so all three
// agree on what counts as a key (e.g. `export SITEPASS_SECRET = "..."`).
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim().replace(/^export\s+/, '')
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq === -1) return null
  const key = trimmed.slice(0, eq).trim()
  if (key === '') return null
  const raw = trimmed.slice(eq + 1).trim()
  const quote = raw[0] === '"' || raw[0] === "'" || raw[0] === '`' ? raw[0] : undefined
  if (quote) {
    const end = raw.indexOf(quote, 1)
    // Honor the quotes only when whatever follows the closing one is a
    // comment; otherwise (e.g. a lone ") dotenv falls back to unquoted rules.
    if (end !== -1 && /^\s*(#.*)?$/.test(raw.slice(end + 1))) {
      const inner = raw.slice(1, end)
      return [key, quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner]
    }
  }
  const hash = raw.indexOf('#')
  return [key, (hash === -1 ? raw : raw.slice(0, hash)).trim()]
}

// Render a value so that parseEnvLine and dotenv both read it back verbatim.
// dotenv keeps \" escapes literally and expands \n only inside double quotes,
// so instead of escaping, wrap in whichever quote character the value lacks.
function formatEnvValue(value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error('Env values cannot contain newlines; set this one by hand if you need it.')
  }
  if (!/[#'"`]|^\s|\s$/.test(value)) return value
  for (const quote of ['"', "'", '`']) {
    if (value.includes(quote)) continue
    // Double quotes would turn a literal \n or \r into a real newline.
    if (quote === '"' && /\\[nr]/.test(value)) continue
    return `${quote}${value}${quote}`
  }
  throw new Error(`Cannot write an env value containing ", ', and \` — simplify it.`)
}

export function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const parsed = parseEnvLine(line)
    if (parsed && parsed[0] === key) return parsed[1]
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
    const line = `${key}=${formatEnvValue(value)}`
    // Match the parsed key, not a literal prefix, so a hand-edited `KEY = x`
    // or `export KEY=x` line is updated in place instead of leaving a stale
    // duplicate that dotenv would resolve last-wins.
    const index = lines.findIndex((existing) => parseEnvLine(existing)?.[0] === key)
    if (index === -1) {
      lines.push(line)
    } else {
      // Keep an `export ` prefix so a file that is also shell-sourced still
      // exports the updated value.
      lines[index] = /^\s*export\s/.test(lines[index] ?? '') ? `export ${line}` : line
    }
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
// >= 20.12 while engines allow >= 20, so parse the file directly. Real env
// always wins over the file. `required` distinguishes the implicit .env
// default (fine to skip) from an explicit --env-file (a typo must be an error).
export function loadDotenv(path: string, required = false) {
  if (!existsSync(path)) {
    if (required) throw new Error(`Env file not found: ${path}`)
    return
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const parsed = parseEnvLine(line)
    if (parsed && !(parsed[0] in process.env)) process.env[parsed[0]] = parsed[1]
  }
}
