import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProviderStream } from '../llm'

const MESSAGES = [{ role: 'user', content: 'test' }]
const TOOLS: any[] = []

// Mock fetch globally
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function makeOkStream() {
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return { ok: true, status: 200, body: readable, text: async () => '' }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(makeOkStream())
})

describe('createProviderStream — provider dispatch', () => {
  it('throws for unknown provider', async () => {
    await expect(createProviderStream(MESSAGES, TOOLS, { provider: 'foobar' }))
      .rejects.toThrow('Unknown provider "foobar"')
  })

  it('throws for default/undefined provider', async () => {
    await expect(createProviderStream(MESSAGES, TOOLS, { provider: 'default' }))
      .rejects.toThrow('Unknown provider')
    await expect(createProviderStream(MESSAGES, TOOLS, {}))
      .rejects.toThrow('Unknown provider')
  })

  it('builds an OpenAI-compatible POST for openai', async () => {
    await createProviderStream(MESSAGES, TOOLS, { provider: 'openai', apiKey: 'sk-test' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-4o')
    expect(body.stream).toBe(true)
    expect(init.headers['Authorization']).toBe('Bearer sk-test')
  })

  it('builds an Ollama URL from baseUrl', async () => {
    await createProviderStream(MESSAGES, TOOLS, {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('falls back to localhost:11434 for ollama with no baseUrl', async () => {
    await createProviderStream(MESSAGES, TOOLS, { provider: 'ollama' })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('routes gemini to the SDK adapter, never to fetch, and needs a key', async () => {
    await expect(createProviderStream(MESSAGES, TOOLS, { provider: 'gemini' })).rejects.toThrow(/GEMINI_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a client-chosen base URL that points at an internal address, before any request', async () => {
    for (const baseUrl of ['http://169.254.169.254', 'http://metadata.google.internal']) {
      await expect(createProviderStream(MESSAGES, TOOLS, { provider: 'ollama', baseUrl, clientBaseUrl: true }))
        .rejects.toThrow(/Blocked URL/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not forward the provider-private turn record to OpenAI-compatible APIs', async () => {
    const history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', native: { parts: [] } }]
    await createProviderStream(history, TOOLS, { provider: 'openai', apiKey: 'sk-test' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1]).toEqual({ role: 'assistant', content: 'a' })
  })

  it('builds an Anthropic messages POST for claude', async () => {
    await createProviderStream(MESSAGES, TOOLS, {
      provider: 'claude',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-ant-test')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(init.body)
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.tools)).toBe(true)
  })

  it('sends converted Anthropic history and defaults to claude-sonnet-5-5, overridable by env', async () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]
    await createProviderStream(msgs, TOOLS, { provider: 'claude', apiKey: 'k' })
    let body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('claude-sonnet-5-5')
    // Cache breakpoints: end of the system prompt (tools + system) and end of the latest turn.
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] }])

    vi.stubEnv('GEOAGENT_MODEL_CLAUDE', 'claude-opus-5-5')
    await createProviderStream(msgs, TOOLS, { provider: 'claude', apiKey: 'k' })
    body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.model).toBe('claude-opus-5-5')
    vi.unstubAllEnvs()
  })

  it('uses model override when supplied', async () => {
    await createProviderStream(MESSAGES, TOOLS, {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gpt-4o-mini')
  })

  it('throws on provider HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    await expect(createProviderStream(MESSAGES, TOOLS, { provider: 'openai', apiKey: 'bad' }))
      .rejects.toThrow('401')
  })
})
