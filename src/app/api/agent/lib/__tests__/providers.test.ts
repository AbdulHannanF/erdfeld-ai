import { Writable } from 'node:stream'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { LOG_REDACT } from '../logger'
import { providersStatus, resolveLlmConfig, scrubSecret } from '../providers'

const SERVER = { ANTHROPIC_API_KEY: 'sk-ant-server-secret-0001', OPENAI_API_KEY: 'sk-openai-server-0002' }

describe('server-held keys', () => {
  it('uses the server key when the client sends none, and never lets the client pick the URL for it', () => {
    const r = resolveLlmConfig({ provider: 'claude', baseUrl: 'https://evil.example' }, SERVER)
    expect(r).toMatchObject({ ok: true, config: { provider: 'claude', apiKey: SERVER.ANTHROPIC_API_KEY, baseUrl: undefined } })
  })
  it('lets a client key win (BYO) but still ignores the client base URL while the server holds a key', () => {
    const r = resolveLlmConfig({ provider: 'claude', apiKey: 'sk-mine-123456', baseUrl: 'https://proxy.example' }, SERVER)
    expect(r).toMatchObject({ ok: true, config: { apiKey: 'sk-mine-123456', baseUrl: undefined } })
  })
  it('accepts a public client base URL only when the server holds no key, and flags it for the resolved check', () => {
    const r = resolveLlmConfig({ provider: 'claude', apiKey: 'sk-mine-123456', baseUrl: 'https://proxy.example' }, {})
    expect(r).toMatchObject({ ok: true, config: { baseUrl: 'https://proxy.example', clientBaseUrl: true } })
  })
  it('refuses metadata, link-local and private client base URLs', () => {
    for (const baseUrl of ['http://169.254.169.254', 'http://metadata.google.internal', 'http://10.0.0.5:11434', 'file:///etc/passwd']) {
      const r = resolveLlmConfig({ provider: 'ollama', baseUrl }, { NODE_ENV: 'development' })
      expect(r.ok, baseUrl).toBe(false)
    }
  })
  it('allows a localhost ollama outside production only', () => {
    expect(resolveLlmConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434' }, { NODE_ENV: 'development' }).ok).toBe(true)
    expect(resolveLlmConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434' }, { NODE_ENV: 'production' }).ok).toBe(false)
  })
  it('ignores client base URLs entirely when client keys are disabled', () => {
    const r = resolveLlmConfig({ provider: 'ollama', baseUrl: 'http://169.254.169.254' }, { GEOAGENT_DISABLE_CLIENT_KEYS: '1' })
    expect(r).toMatchObject({ ok: true, config: { baseUrl: undefined } })
  })
  it('never takes a base URL for gemini, and makes gemini the default when its server key exists', () => {
    const env = { GEMINI_API_KEY: 'AIza-server-key-0003' }
    const r = resolveLlmConfig({ provider: 'default', baseUrl: 'https://evil.example' }, env)
    expect(r).toMatchObject({ ok: true, config: { provider: 'gemini', apiKey: env.GEMINI_API_KEY, baseUrl: undefined } })
    expect(providersStatus(env).default_provider).toBe('gemini')
  })
  it('ignores a client key when GEOAGENT_DISABLE_CLIENT_KEYS=1', () => {
    const env = { ...SERVER, GEOAGENT_DISABLE_CLIENT_KEYS: '1' }
    const r = resolveLlmConfig({ provider: 'openai', apiKey: 'sk-mine-123456' }, env)
    expect(r).toMatchObject({ ok: true, config: { apiKey: SERVER.OPENAI_API_KEY } })
    const none = resolveLlmConfig({ provider: 'gemini', apiKey: 'sk-mine-123456' }, env)
    expect(none.ok).toBe(false)
    expect(!none.ok && none.message).toMatch(/GEMINI_API_KEY/)
  })
  it('says what is missing when no key exists anywhere', () => {
    const r = resolveLlmConfig({ provider: 'gemini' }, {})
    expect(!r.ok && r.message).toMatch(/GEMINI_API_KEY/)
  })
  it('needs no key for ollama, and resolves `default` through GEOAGENT_DEFAULT_PROVIDER', () => {
    expect(resolveLlmConfig({ provider: 'ollama' }, {}).ok).toBe(true)
    const r = resolveLlmConfig({ provider: 'default', baseUrl: 'https://evil.example' }, { ...SERVER, GEOAGENT_DEFAULT_PROVIDER: 'claude' })
    expect(r).toMatchObject({ ok: true, config: { provider: 'claude', apiKey: SERVER.ANTHROPIC_API_KEY, baseUrl: undefined } })
    expect(resolveLlmConfig({ provider: 'default' }, {}).ok).toBe(false)
  })
  it('reports configuration without any key', () => {
    const status = providersStatus({ ...SERVER, GEOAGENT_DEFAULT_PROVIDER: 'claude' })
    expect(status.default_provider).toBe('claude')
    expect(status.providers.find((p) => p.id === 'claude')?.server_key).toBe(true)
    expect(status.providers.find((p) => p.id === 'gemini')?.server_key).toBe(false)
    expect(JSON.stringify(status)).not.toContain('secret')
    expect(JSON.stringify(status)).not.toContain('sk-')
  })
})

describe('keys never reach logs or error text', () => {
  it('pino redacts credential fields, top level and nested', () => {
    const lines: string[] = []
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb() } })
    const log = pino({ redact: LOG_REDACT }, sink)
    log.info({ apiKey: 'sk-live-AAAA', config: { apiKey: 'sk-live-BBBB', provider: 'claude' }, headers: { 'x-api-key': 'sk-live-CCCC', authorization: 'Bearer sk-live-DDDD' } }, 'x')
    const out = lines.join('')
    expect(out).not.toMatch(/sk-live/)
    expect(out).toContain('claude')
  })
  it('scrubs a key a provider echoes back in an error', () => {
    // A fake key in the real prefix shape, assembled at runtime so the repo's secret scanner stays strict.
    const prefix = ['sk', 'ant', 'api03', ''].join('-')
    const key = `${prefix}abcdefghijklmnop`
    const text = scrubSecret(`invalid x-api-key: ${key}; prefix ${prefix}abc...`, key)
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain(prefix)
  })
})
