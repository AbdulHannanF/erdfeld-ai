/** AI-02 — which model provider a request uses, and whose API key pays for it.
 *
 *  A hosted deployment holds the provider keys itself (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 *  `GEMINI_API_KEY`) so a browser never needs one. A key the browser sends (bring your own key)
 *  still works unless `GEOAGENT_DISABLE_CLIENT_KEYS=1`. `GEOAGENT_DEFAULT_PROVIDER` names the
 *  provider used when a request says `default` (`AGENT_DEFAULT_PROVIDER` is the older spelling).
 *
 *  Pure over an injected `env`, so it is unit-testable. Nothing here logs or returns a key except
 *  `resolveLlmConfig`, whose result goes straight to the provider request.
 */

import { checkUrlSyntax } from '@/lib/url-guard'

import { DEFAULT_MODELS, defaultModel, type ModelProvider } from './models'

/** The env var holding the server-side key of each provider that needs one. */
export const SERVER_KEY_ENV = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
} as const

type KeyedProvider = keyof typeof SERVER_KEY_ENV
type Env = Record<string, string | undefined>

const isKeyed = (p: string | undefined): p is KeyedProvider => !!p && p in SERVER_KEY_ENV
const clean = (v: string | undefined): string | undefined => v?.trim() || undefined

export function serverKey(provider: string | undefined, env: Env = process.env): string | undefined {
  return isKeyed(provider) ? clean(env[SERVER_KEY_ENV[provider]]) : undefined
}

export function clientKeysDisabled(env: Env = process.env): boolean {
  return env.GEOAGENT_DISABLE_CLIENT_KEYS === '1'
}

/** The provider a `default` request resolves to: the one the deployment names, else Gemini when
 *  the server holds a Gemini key. */
export function serverDefaultProvider(env: Env = process.env): string | undefined {
  return clean(env.GEOAGENT_DEFAULT_PROVIDER) ?? clean(env.AGENT_DEFAULT_PROVIDER) ?? (serverKey('gemini', env) ? 'gemini' : undefined)
}

/** What `GET /api/providers` reports: which providers the server can run without a browser key. */
export interface ProvidersStatus {
  default_provider: string | null
  /** False when the browser may not supply its own key. */
  client_keys: boolean
  providers: Array<{ id: ModelProvider; server_key: boolean; default_model: string }>
}

export function providersStatus(env: Env = process.env): ProvidersStatus {
  return {
    default_provider: serverDefaultProvider(env) ?? null,
    client_keys: !clientKeysDisabled(env),
    providers: (Object.keys(DEFAULT_MODELS) as ModelProvider[]).map((id) => ({
      id,
      server_key: !!serverKey(id, env),
      default_model: defaultModel(id),
    })),
  }
}

export interface LlmRequestConfig {
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  /** True when `baseUrl` came from the browser, so the connection must still pass the resolved
   *  SSRF check (`assertSafeUrl`) before anything is sent. */
  clientBaseUrl?: boolean
}

export type ResolvedLlm = { ok: true; config: LlmRequestConfig } | { ok: false; message: string }

/** Pick provider, key, base URL and model for one request.
 *
 *  Key order: the operator's `AGENT_DEFAULT_API_KEY` (only when the request defers to the server
 *  default), then the browser's own key (unless client keys are disabled), then the provider's
 *  server key.
 *
 *  A base URL from the request is ignored entirely when the server holds a key for the provider
 *  (a client-chosen URL must not receive it) or client keys are disabled. Gemini is reached
 *  through its SDK and never takes one. Otherwise it must be an http(s) URL on a public host
 *  (loopback only outside production); the DNS-resolved check follows at connection time. */
export function resolveLlmConfig(req: LlmRequestConfig, env: Env = process.env): ResolvedLlm {
  const envProvider = serverDefaultProvider(env)
  const useDefault = (!req.provider || req.provider === 'default') && !!envProvider
  const provider = useDefault ? envProvider : req.provider
  if (!provider || provider === 'default') {
    return {
      ok: false,
      message:
        'No AI provider is configured. Open Settings → AI Model and choose one ' +
        '(Ollama is the recommended no-key default — runs locally with no API key), ' +
        'or set GEOAGENT_DEFAULT_PROVIDER on the server.',
    }
  }

  const clientKey = clientKeysDisabled(env) ? undefined : clean(req.apiKey)
  const operatorKey = useDefault ? clean(env.AGENT_DEFAULT_API_KEY) : undefined
  const providerKey = serverKey(provider, env)
  const serverHeld = operatorKey ?? (clientKey ? undefined : providerKey)
  const apiKey = operatorKey ?? clientKey ?? providerKey

  if (isKeyed(provider) && !apiKey) {
    const name = SERVER_KEY_ENV[provider]
    return {
      ok: false,
      message: clientKeysDisabled(env)
        ? `This deployment does not accept browser-supplied API keys and has no ${name} configured for ${provider}.`
        : `No API key for ${provider}. Enter yours in Settings → AI Model, or set ${name} on the server.`,
    }
  }

  const envBase = useDefault ? clean(env.AGENT_DEFAULT_BASE_URL) ?? clean(env.OLLAMA_BASE_URL) : undefined
  const requested = clean(req.baseUrl)
  const clientMayChooseBase = !serverHeld && !providerKey && !clientKeysDisabled(env) && provider !== 'gemini'
  if (envBase === undefined && requested && clientMayChooseBase) {
    const check = checkUrlSyntax(requested, env)
    if (!check.ok) return { ok: false, message: `The AI base URL was refused: ${check.reason}.` }
  }
  const clientBaseUrl = envBase === undefined && !!requested && clientMayChooseBase
  const baseUrl = envBase ?? (clientBaseUrl ? requested : undefined)
  const model = (useDefault ? clean(env.AGENT_DEFAULT_MODEL) : undefined) ?? clean(req.model)
  return { ok: true, config: { provider, apiKey, baseUrl, model, ...(clientBaseUrl ? { clientBaseUrl } : {}) } }
}

/** Remove a key from text that may be shown to the user or logged (providers sometimes echo the
 *  key they rejected, in full or as a prefix). */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text
  return text.split(secret).join('[redacted]').split(secret.slice(0, 12)).join('[redacted]')
}
