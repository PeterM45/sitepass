import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Importing the CLI module must NOT execute it: the entrypoint is guarded by
// an is-main check, which is itself implicitly under test here.
import {
  ensureGitignored,
  flagEnabled,
  loadDotenv,
  main,
  parseFlags,
  readEnvValue,
  rejectUnknownFlags,
  upsertEnv,
} from '../src/cli'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sitepass-cli-'))
}

// dotenv's parse rules (the LINE regex and post-processing from dotenv@17
// src/main.js — the parser Next, Astro dev, and wrangler use), replicated here
// so round-trip tests prove real-world compatibility without adding a
// dependency: quotes stripped, \n and \r expanded inside double quotes only.
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm

function dotenvParse(src: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const match of src.replace(/\r\n?/gm, '\n').matchAll(DOTENV_LINE)) {
    const key = match[1]
    if (key === undefined) continue
    let value = (match[2] ?? '').trim()
    const maybeQuote = value[0]
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2')
    if (maybeQuote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    parsed[key] = value
  }
  return parsed
}

describe('parseFlags', () => {
  it('parses space-separated, =-separated, and boolean flags', () => {
    expect(parseFlags(['--target', 'next', '--password=pw', '--insecure-cookie'])).toEqual({
      target: 'next',
      password: 'pw',
      'insecure-cookie': true,
    })
  })

  it('treats a flag followed by another flag as boolean', () => {
    expect(parseFlags(['--help', '--target', 'next'])).toEqual({ help: true, target: 'next' })
  })

  it('rejects single-dash flags, pointing at the two-dash spelling', () => {
    expect(() => parseFlags(['-public-paths', '/admin'])).toThrow(/--public-paths/)
    expect(() => parseFlags(['--port', '8080', '-insecure-cookie'])).toThrow(/--insecure-cookie/)
  })

  it('rejects stray positional tokens', () => {
    expect(() => parseFlags(['stray', '--port', '8080'])).toThrow(/"stray"/)
  })

  it('still accepts flag values that start with a single dash', () => {
    expect(parseFlags(['--password', '-pw'])).toEqual({ password: '-pw' })
  })
})

// Drive the real entrypoint via process.argv, capturing console output and the
// exit code, so these tests cover the command routing main() does before the
// helpers (the layer the unit tests below can't reach).
async function runMain(...args: string[]) {
  const logs: string[] = []
  const errors: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts) => {
    logs.push(parts.join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts) => {
    errors.push(parts.join(' '))
  })
  const argv = process.argv
  const exitCode = process.exitCode
  process.argv = ['node', 'sitepass', ...args]
  process.exitCode = undefined
  try {
    await main()
    return { logs, errors, exitCode: process.exitCode }
  } finally {
    process.argv = argv
    process.exitCode = exitCode
    logSpy.mockRestore()
    errorSpy.mockRestore()
  }
}

describe('main', () => {
  it('prints usage for `sitepass help <topic>` instead of rejecting the positional', async () => {
    const result = await runMain('help', 'init')
    expect(result.exitCode).toBeUndefined()
    expect(result.errors).toEqual([])
    expect(result.logs.join('\n')).toContain('Usage:')
  })

  it('lets --version outrank the help command, as on every other command', async () => {
    const result = await runMain('help', '--version')
    expect(result.exitCode).toBeUndefined()
    expect(result.logs).toHaveLength(1)
    expect(result.logs.join('\n')).not.toContain('Usage:')
  })

  it('rejects a value flag given without a value instead of using the default', async () => {
    // A bare --env-file silently loading the implicit .env would drop explicit
    // user intent, the same failure mode as a typo'd --env-file path.
    const result = await runMain('proxy', '--origin', 'http://localhost:9', '--env-file')
    expect(result.exitCode).toBe(1)
    expect(result.errors.join('\n')).toMatch(/--env-file requires a value/)
  })

  it('rejects a bare --env-file on init before writing anything', async () => {
    const dir = tmp()
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await runMain('init', '--target', 'next', '--env-file')
      expect(result.exitCode).toBe(1)
      expect(result.errors.join('\n')).toMatch(/--env-file requires a value/)
      expect(readEnvValue(join(dir, '.env'), 'SITEPASS_SECRET')).toBeUndefined()
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('flagEnabled', () => {
  it('treats the bare flag and explicit truthy values as enabled', () => {
    expect(flagEnabled('insecure-cookie', true)).toBe(true)
    expect(flagEnabled('insecure-cookie', '')).toBe(true)
    expect(flagEnabled('insecure-cookie', 'true')).toBe(true)
    expect(flagEnabled('insecure-cookie', '1')).toBe(true)
  })

  it('treats an explicit false / 0 / absent as disabled', () => {
    expect(flagEnabled('insecure-cookie', 'false')).toBe(false)
    expect(flagEnabled('insecure-cookie', '0')).toBe(false)
    expect(flagEnabled('insecure-cookie', undefined)).toBe(false)
  })

  it('rejects unrecognized spellings instead of silently disabling', () => {
    // =yes silently meaning "Secure stays on" would recreate the login loop.
    expect(() => flagEnabled('insecure-cookie', 'yes')).toThrow(/--insecure-cookie=true/)
    expect(() => flagEnabled('insecure-cookie', 'TRUE')).toThrow(/"TRUE"/)
    expect(() => flagEnabled('insecure-cookie', 'on')).toThrow(/--insecure-cookie/)
  })
})

describe('rejectUnknownFlags', () => {
  it('accepts known flags and rejects typos with the known list', () => {
    expect(() =>
      rejectUnknownFlags('proxy', { origin: 'http://x', port: '1', 'trust-proxy': true }),
    ).not.toThrow()
    expect(() => rejectUnknownFlags('proxy', { 'public-path': 'a' })).toThrow(/--public-path\b/)
    expect(() => rejectUnknownFlags('init', { origin: 'http://x' })).toThrow(/--origin/)
  })
})

describe('upsertEnv', () => {
  it('creates the env file with owner-only permissions', () => {
    const path = join(tmp(), '.env')
    upsertEnv(path, { SITEPASS_PASSWORD: 'pw', SITEPASS_SECRET: 's3cret' })
    expect(readFileSync(path, 'utf8')).toBe('SITEPASS_PASSWORD=pw\nSITEPASS_SECRET=s3cret\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('updates keys in place, preserves other lines, and tightens loose permissions', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, '# comment\nOTHER=keep\nSITEPASS_SECRET=old\n', { mode: 0o644 })
    upsertEnv(path, { SITEPASS_SECRET: 'new', SITEPASS_PASSWORD: 'pw' })
    expect(readFileSync(path, 'utf8')).toBe(
      '# comment\nOTHER=keep\nSITEPASS_SECRET=new\nSITEPASS_PASSWORD=pw\n',
    )
    // A pre-existing world-readable env file must end up 0600, not stay 0644.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('updates export-prefixed lines in place, keeping the export', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, 'export SITEPASS_SECRET=old\nexport OTHER=keep\n')
    upsertEnv(path, { SITEPASS_SECRET: 'new', SITEPASS_PASSWORD: 'pw' })
    // No appended duplicate: dotenv would resolve last-wins to the wrong value.
    expect(readFileSync(path, 'utf8')).toBe(
      'export SITEPASS_SECRET=new\nexport OTHER=keep\nSITEPASS_PASSWORD=pw\n',
    )
  })

  it('quotes values so dotenv and sitepass read back exactly what was written', () => {
    const path = join(tmp(), '.env')
    const values = [
      'pw#secret',
      'value # not a comment',
      "it's",
      'say "hi"',
      `both ' and "`,
      '  padded  ',
      'pw#with\\nliteral',
      'literal\\nstays',
      'plain',
    ]
    for (const value of values) {
      upsertEnv(path, { SITEPASS_PASSWORD: value })
      expect(readEnvValue(path, 'SITEPASS_PASSWORD')).toBe(value)
      expect(dotenvParse(readFileSync(path, 'utf8')).SITEPASS_PASSWORD).toBe(value)
    }
  })

  it('rejects values no env file can represent', () => {
    const path = join(tmp(), '.env')
    expect(() => upsertEnv(path, { SITEPASS_PASSWORD: 'a\nb' })).toThrow(/newline/)
    expect(() => upsertEnv(path, { SITEPASS_PASSWORD: 'a"b\'c`d' })).toThrow(/simplify/)
  })
})

describe('readEnvValue', () => {
  it('reads a key, returns undefined for missing keys and missing files', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, 'A=1\nB=two words\n')
    expect(readEnvValue(path, 'A')).toBe('1')
    expect(readEnvValue(path, 'B')).toBe('two words')
    expect(readEnvValue(path, 'C')).toBeUndefined()
    expect(readEnvValue(join(tmp(), 'nope'), 'A')).toBeUndefined()
  })

  it('reads export-prefixed keys, so init keeps an existing secret', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, 'export SITEPASS_SECRET=oldsecret-0123456789abcdef\n')
    expect(readEnvValue(path, 'SITEPASS_SECRET')).toBe('oldsecret-0123456789abcdef')
  })

  it('strips inline comments from unquoted values the way dotenv does', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, 'A=value # comment\nB="kept # inside" # outside\nC=value#x\n')
    for (const key of ['A', 'B', 'C']) {
      expect(readEnvValue(path, key)).toBe(dotenvParse(readFileSync(path, 'utf8'))[key])
    }
    expect(readEnvValue(path, 'A')).toBe('value')
    expect(readEnvValue(path, 'B')).toBe('kept # inside')
    expect(readEnvValue(path, 'C')).toBe('value')
  })
})

describe('ensureGitignored', () => {
  // ensureGitignored works on cwd-relative paths; isolate each case in a tmpdir.
  let dir: string
  let cwd: string
  beforeEach(() => {
    dir = tmp()
    cwd = process.cwd()
    process.chdir(dir)
  })
  afterEach(() => process.chdir(cwd))

  it('skips outside a git project', () => {
    expect(ensureGitignored('.env')).toBe('skipped')
  })

  it('adds the entry once in a git project, then reports it present', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    expect(ensureGitignored('.env')).toBe('added')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.env\n')
    expect(ensureGitignored('.env')).toBe('present')
  })

  it('recognizes a covering .env* pattern', () => {
    writeFileSync(join(dir, '.gitignore'), '.env*\n')
    expect(ensureGitignored('.env')).toBe('present')
    expect(ensureGitignored('.dev.vars')).toBe('added')
  })
})

describe('loadDotenv', () => {
  it('loads KEY=VALUE lines without overriding the real environment', () => {
    const path = join(tmp(), '.env')
    writeFileSync(
      path,
      '# comment\nSITEPASS_TEST_A=plain\nSITEPASS_TEST_B="quoted value"\nSITEPASS_TEST_C=\n',
    )
    process.env.SITEPASS_TEST_B = 'already-set'
    try {
      loadDotenv(path)
      expect(process.env.SITEPASS_TEST_A).toBe('plain')
      expect(process.env.SITEPASS_TEST_B).toBe('already-set')
      expect(process.env.SITEPASS_TEST_C).toBe('')
    } finally {
      delete process.env.SITEPASS_TEST_A
      delete process.env.SITEPASS_TEST_B
      delete process.env.SITEPASS_TEST_C
    }
  })

  it('loads export-prefixed keys under the bare name', () => {
    const path = join(tmp(), '.env')
    writeFileSync(path, 'export SITEPASS_TEST_D=exported\n')
    try {
      loadDotenv(path)
      expect(process.env.SITEPASS_TEST_D).toBe('exported')
      expect('export SITEPASS_TEST_D' in process.env).toBe(false)
    } finally {
      delete process.env.SITEPASS_TEST_D
    }
  })

  it('is a no-op for a missing implicit file, but errors when required', () => {
    const absent = join(tmp(), 'absent')
    expect(() => loadDotenv(absent)).not.toThrow()
    // An explicit --env-file typo must not be silently ignored.
    expect(() => loadDotenv(absent, true)).toThrow(/Env file not found/)
  })
})
