#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { startProxy } from './proxy'

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

main()

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  try {
    if (command === 'init') await runInit(flags)
    else if (command === 'proxy') runProxy(flags)
    else if (command === undefined || command === 'help' || flags.help) printHelp()
    else {
      console.error(`Unknown command: ${command}\n`)
      printHelp()
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

async function runInit(flags: Flags) {
  const target = await resolveTarget(flags)
  const envPath = target === 'cloudflare' ? '.dev.vars' : '.env'

  // Never clobber an existing secret: a regenerated one would invalidate every
  // live session. Keep the password the user already set, too.
  const existingSecret = readEnvValue(envPath, 'SITEPASS_SECRET')
  const existingPassword = readEnvValue(envPath, 'SITEPASS_PASSWORD')
  const secret = existingSecret || generateSecret()

  let password = existingPassword || asString(flags.password) || ''
  if (!password && isInteractive()) {
    password = await prompt('Shared password (leave blank to set later): ')
  }

  upsertEnv(envPath, { SITEPASS_PASSWORD: password, SITEPASS_SECRET: secret })

  console.log(`\nWrote ${envPath}`)
  console.log(`  SITEPASS_SECRET    ${existingSecret ? 'kept existing value' : 'generated'}`)
  console.log(`  SITEPASS_PASSWORD  ${password ? 'set' : 'empty, fill it in before deploying'}`)
  console.log(`\n${snippetFor(target)}`)
}

function runProxy(flags: Flags) {
  const origin = asString(flags.origin)
  if (!origin)
    throw new Error('sitepass proxy requires --origin <url>, e.g. --origin http://localhost:8080')
  const port = Number(asString(flags.port)) || 8788

  loadDotenv()
  const password = process.env.SITEPASS_PASSWORD ?? ''
  const secret = process.env.SITEPASS_SECRET ?? ''
  if (!secret) {
    console.warn(
      'Warning: SITEPASS_SECRET is not set, so the gate fails closed (503). Run `sitepass init` first.',
    )
  }

  startProxy({ origin, port, password, secret })
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
  console.log(`sitepass: one shared password in front of any web app

Usage:
  sitepass init [--target <name>] [--password <pw>]
  sitepass proxy --origin <url> [--port <n>]

init   generate a secret, write the env file, and print the wiring snippet
proxy  run a gating reverse proxy in front of an existing origin

Targets: ${TARGETS.join(', ')}`)
}

// --- small helpers ---

type Flags = Record<string, string | boolean>

function parseFlags(args: string[]): Flags {
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

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
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

function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim()
  }
  return undefined
}

// Update or append the given keys, preserving every other line in the file.
function upsertEnv(path: string, updates: Record<string, string>) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`
    const index = lines.findIndex((existing) => existing.startsWith(`${key}=`))
    if (index === -1) lines.push(line)
    else lines[index] = line
  }
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`)
}

function loadDotenv() {
  try {
    process.loadEnvFile('.env')
  } catch {
    // No .env file; fall back to the real environment.
  }
}
