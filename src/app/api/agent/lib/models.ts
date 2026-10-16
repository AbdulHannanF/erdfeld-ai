/**
 * Default model per provider, used when the request names none. Each can be overridden on
 * the server with `GEOAGENT_MODEL_<PROVIDER>` (e.g. `GEOAGENT_MODEL_CLAUDE=claude-opus-5-5`)
 * so a model retirement is a config change, not a code change.
 *
 * Gemini uses pinned stable ids, never a floating `-latest` alias: a silent alias move would
 * change planner behaviour between deploys. `GEOAGENT_MODEL_GEMINI_FALLBACKS` (comma separated)
 * is the ordered chain tried when the primary keeps failing with 429/5xx.
 */
export const DEFAULT_MODELS = {
  ollama: 'gemma4:e4b',
  openai: 'gpt-4o',
  gemini: 'gemini-3.8-flash',
  claude: 'claude-sonnet-5-5',
  custom: 'gpt-4o',
} as const

export const DEFAULT_GEMINI_FALLBACKS = ['gemini-3.5-flash', 'gemini-2.5-flash'] as const

export type ModelProvider = keyof typeof DEFAULT_MODELS

export function defaultModel(provider: ModelProvider): string {
  return process.env[`GEOAGENT_MODEL_${provider.toUpperCase()}`]?.trim() || DEFAULT_MODELS[provider]
}

/** The ordered Gemini models to try: the chosen one, then the fallback chain (no repeats). */
export function geminiModelChain(primary?: string, env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.GEOAGENT_MODEL_GEMINI_FALLBACKS
  const fallbacks = raw === undefined
    ? [...DEFAULT_GEMINI_FALLBACKS]
    : raw.split(',').map((m) => m.trim()).filter(Boolean)
  const first = primary?.trim() || env.GEOAGENT_MODEL_GEMINI?.trim() || DEFAULT_MODELS.gemini
  return [...new Set([first, ...fallbacks])]
}

/** Gemma models are served on the Gemini API but take no `thinkingLevel` of Gemini's scale. */
export function isGemma(model: string): boolean {
  return /^(models\/)?gemma-/i.test(model)
}
