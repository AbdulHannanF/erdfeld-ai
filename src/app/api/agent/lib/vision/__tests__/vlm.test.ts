/** Tests for the VLM inspection backend.
 *
 *  The wire-format tests run against a REAL local HTTP server rather than a
 *  mocked `fetch`, because the thing that can be wrong here is the bytes on the
 *  wire — a mock asserts only that we called something. The server records the
 *  exact request body and the assertions read it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  buildVlmBody,
  describeImage,
  extractVlmText,
  probeOllamaVision,
  resolveVlm,
  type VlmConfig,
} from '../vlm'

// ---------------------------------------------------------------------------
// A real HTTP server standing in for a model host
// ---------------------------------------------------------------------------

interface Recorded { url: string; headers: Record<string, any>; body: any }

let server: Server
let base = ''
const received: Recorded[] = []
/** Route table the tests rewrite per case: path → [status, jsonBody]. */
let routes: Record<string, [number, any]> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      received.push({ url: req.url ?? '', headers: req.headers as any, body })
      const route = routes[req.url ?? '']
      if (!route) { res.writeHead(404).end('{}'); return }
      res.writeHead(route[0], { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route[1]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function reset() {
  received.length = 0
  routes = {}
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

// ---------------------------------------------------------------------------
// Backend resolution
// ---------------------------------------------------------------------------

describe('resolveVlm', () => {
  it('refuses, naming the fix, when nothing is configured', async () => {
    const r = await resolveVlm(undefined, {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/VLM_ENDPOINT/)
    expect(r.reason).toMatch(/Settings/)
  })

  it('never invents a description from statistics as a fallback', async () => {
    const r = await resolveVlm(undefined, {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/inventing a picture/)
  })

  it('takes an explicit sidecar first', async () => {
    const r = await resolveVlm({ provider: 'openai', apiKey: 'k' }, {
      VLM_ENDPOINT: 'http://box:8000/v1/',
      VLM_MODEL: 'qwen2.5vl:7b',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.baseUrl).toBe('http://box:8000/v1')
    expect(r.config.model).toBe('qwen2.5vl:7b')
    expect(r.config.wire).toBe('openai')   // inferred from the /v1 suffix
    expect(r.config.origin).toBe('VLM_ENDPOINT')
  })

  it('reaches Gemini vision with the Cloud Run configuration (deploy/cloudrun/deploy.sh), even for a job with no AI settings', async () => {
    const r = await resolveVlm(undefined, {
      VLM_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/openai',
      VLM_WIRE: 'openai',
      VLM_MODEL: 'gemini-3.8-flash',
      VLM_API_KEY: 'gemini-key',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const req = buildVlmBody({ config: r.config, images: [PNG_B64], prompt: 'p' })
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(req.headers.Authorization).toBe('Bearer gemini-key')
    expect((req.body as { model: string }).model).toBe('gemini-3.8-flash')
    // without VLM_WIRE the URL (no /v1 suffix) would be read as an Ollama server
    const inferred = await resolveVlm(undefined, { VLM_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/openai', VLM_MODEL: 'm' })
    expect(inferred.ok && inferred.config.wire).toBe('ollama')
  })

  it('refuses when VLM_ENDPOINT is set without a model rather than guessing one', async () => {
    const r = await resolveVlm(undefined, { VLM_ENDPOINT: 'http://box:8000' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/VLM_MODEL/)
  })

  it('reuses a vision-capable provider the user already configured', async () => {
    const r = await resolveVlm({ provider: 'claude', apiKey: 'sk-x', model: 'claude-opus-4-7' }, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.wire).toBe('claude')
    expect(r.config.apiKey).toBe('sk-x')
    expect(r.config.origin).toMatch(/Settings/)
  })

  it('does not treat a configured provider without a key as usable', async () => {
    const r = await resolveVlm({ provider: 'openai' }, {})
    expect(r.ok).toBe(false)
  })

  it('reports an unreachable Ollama endpoint instead of assuming it works', async () => {
    // Port 1 is reserved and refuses instantly.
    const r = await resolveVlm(undefined, { OLLAMA_BASE_URL: 'http://127.0.0.1:1' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/did not respond/)
    expect(r.reason).toMatch(/imagines/)
  })
})

// ---------------------------------------------------------------------------
// Ollama capability probe — a text-only model must NOT be used for vision
// ---------------------------------------------------------------------------

describe('probeOllamaVision', () => {
  it('picks a model that reports the vision capability', async () => {
    reset()
    routes['/api/tags'] = [200, { models: [{ name: 'gemma4:26b' }, { name: 'qwen2.5vl:7b' }] }]
    routes['/api/show'] = [200, { capabilities: ['completion'] }]
    // First call answers for gemma4, then swap the answer for qwen.
    let calls = 0
    routes['/api/show'] = [200, {}]
    const srvRoutes = routes
    // Re-point /api/show dynamically by counting calls.
    Object.defineProperty(srvRoutes, '/api/show', {
      configurable: true,
      get() {
        calls++
        return calls === 1
          ? [200, { capabilities: ['completion'] }]
          : [200, { capabilities: ['completion', 'vision'] }]
      },
    })

    const out = await probeOllamaVision(base)
    expect(out).not.toBeNull()
    expect(out!.model).toBe('qwen2.5vl:7b')
    expect(out!.models).toEqual(['gemma4:26b', 'qwen2.5vl:7b'])
  })

  it('returns no model when nothing served can see', async () => {
    reset()
    routes['/api/tags'] = [200, { models: [{ name: 'gemma4:26b-a4b-it-qat' }] }]
    routes['/api/show'] = [200, { capabilities: ['completion', 'tools'] }]
    const out = await probeOllamaVision(base)
    expect(out).not.toBeNull()
    expect(out!.model).toBe('')
    expect(out!.models).toEqual(['gemma4:26b-a4b-it-qat'])
  })

  it('refuses the whole backend when only text models are served', async () => {
    reset()
    routes['/api/tags'] = [200, { models: [{ name: 'gemma4:26b-a4b-it-qat' }] }]
    routes['/api/show'] = [200, { capabilities: ['completion'] }]
    const r = await resolveVlm(undefined, { OLLAMA_BASE_URL: base })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('gemma4:26b-a4b-it-qat')
    expect(r.reason).toMatch(/vision capability/)
  })

  it('returns null (not a guess) when the server is unreachable', async () => {
    expect(await probeOllamaVision('http://127.0.0.1:1', undefined, 2000)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

describe('buildVlmBody', () => {
  const cfg = (wire: VlmConfig['wire']): VlmConfig => ({
    wire, baseUrl: 'http://host/v1', model: 'm', apiKey: 'key', origin: 'test',
  })

  it('ollama carries bare base64 on the message', () => {
    const { url, body } = buildVlmBody({ images: [PNG_B64], prompt: 'p', config: { ...cfg('ollama'), baseUrl: 'http://host' } })
    expect(url).toBe('http://host/api/chat')
    expect((body as any).messages[0].images).toEqual([PNG_B64])
    expect((body as any).stream).toBe(false)
  })

  it('openai wraps the image as a data URI', () => {
    const { url, headers, body } = buildVlmBody({ images: [PNG_B64], prompt: 'p', config: cfg('openai') })
    expect(url).toBe('http://host/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer key')
    const parts = (body as any).messages[0].content
    expect(parts[0]).toEqual({ type: 'text', text: 'p' })
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  it('claude uses the base64 source block and the version header', () => {
    const { url, headers, body } = buildVlmBody({ images: [PNG_B64], prompt: 'p', config: { ...cfg('claude'), baseUrl: 'http://host' } })
    expect(url).toBe('http://host/v1/messages')
    expect(headers['x-api-key']).toBe('key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const parts = (body as any).messages[0].content
    expect(parts[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_B64 })
    expect(parts[1]).toEqual({ type: 'text', text: 'p' })
  })
})

describe('extractVlmText', () => {
  it('reads each provider response shape', () => {
    expect(extractVlmText('ollama', { message: { content: ' a ' } })).toBe('a')
    expect(extractVlmText('openai', { choices: [{ message: { content: 'b' } }] })).toBe('b')
    expect(extractVlmText('claude', { content: [{ type: 'text', text: 'c' }, { type: 'thinking' }] })).toBe('c')
  })

  it('returns empty for an unexpected shape rather than a stringified object', () => {
    expect(extractVlmText('openai', { unexpected: true })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// describeImage over real HTTP
// ---------------------------------------------------------------------------

describe('describeImage', () => {
  it('sends the image and returns the description (ollama wire)', async () => {
    reset()
    routes['/api/chat'] = [200, { message: { content: 'Solid white cloud covers the whole frame.' } }]
    const out = await describeImage({
      images: [PNG_B64],
      prompt: 'what do you see?',
      config: { wire: 'ollama', baseUrl: base, model: 'qwen2.5vl:7b', origin: 'test' },
    })
    expect(out.text).toBe('Solid white cloud covers the whole frame.')
    expect(out.model).toBe('qwen2.5vl:7b')
    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/api/chat')
    expect(received[0].body.messages[0].images[0]).toBe(PNG_B64)
    expect(received[0].body.messages[0].content).toContain('what do you see?')
  })

  it('sends the image and returns the description (openai wire)', async () => {
    reset()
    routes['/chat/completions'] = [200, { choices: [{ message: { content: 'Irrigated fields.' } }] }]
    const out = await describeImage({
      images: [PNG_B64],
      prompt: 'p',
      config: { wire: 'openai', baseUrl: base, model: 'gpt-4o', apiKey: 'sk-t', origin: 'test' },
    })
    expect(out.text).toBe('Irrigated fields.')
    expect(received[0].headers.authorization).toBe('Bearer sk-t')
    expect(received[0].body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('treats an empty description as a failure, not as "nothing is visible"', async () => {
    reset()
    routes['/api/chat'] = [200, { message: { content: '' } }]
    await expect(describeImage({
      images: [PNG_B64], prompt: 'p',
      config: { wire: 'ollama', baseUrl: base, model: 'm', origin: 'test' },
    })).rejects.toThrow(/empty description/)
  })

  it('surfaces an HTTP error with the model and status', async () => {
    reset()
    routes['/api/chat'] = [500, { error: 'model not found' }]
    await expect(describeImage({
      images: [PNG_B64], prompt: 'p',
      config: { wire: 'ollama', baseUrl: base, model: 'missing', origin: 'test' },
    })).rejects.toThrow(/HTTP 500/)
  })

  it('refuses to call the model with no image', async () => {
    await expect(describeImage({
      images: [], prompt: 'p',
      config: { wire: 'ollama', baseUrl: base, model: 'm', origin: 'test' },
    })).rejects.toThrow(/no image/)
  })
})
