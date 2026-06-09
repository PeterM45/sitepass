import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Importing the CLI module must NOT execute it: the entrypoint is guarded by
// an is-main check, which is itself implicitly under test here.
import {
  ensureGitignored,
  loadDotenv,
  parseFlags,
  readEnvValue,
  rejectUnknownFlags,
  upsertEnv,
} from '../src/cli'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sitepass-cli-'))
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

  it('ignores stray positional tokens', () => {
    expect(parseFlags(['stray', '--port', '8080'])).toEqual({ port: '8080' })
  })
})

describe('rejectUnknownFlags', () => {
  it('accepts known flags and rejects typos with the known list', () => {
    expect(() => rejectUnknownFlags('proxy', { origin: 'http://x', port: '1' })).not.toThrow()
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

  it('is a no-op for a missing file', () => {
    expect(() => loadDotenv(join(tmp(), 'absent'))).not.toThrow()
  })
})
