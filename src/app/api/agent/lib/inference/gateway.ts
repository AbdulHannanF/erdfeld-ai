/** Inference gateway — provider selection + unified runInference() entry point.
 *
 *  Mirrors the `resolveTitilerBase()` / `isGeePreferred()` pattern: a single
 *  env-driven selector, with an honest "none" degrade path that never fabricates.
 *
 *  Provider precedence:
 *   1. Explicit INFERENCE_PROVIDER env var (if the model supports it and it's configured).
 *   2. First auto-detected provider with credentials that supports this model.
 *   3. 'none' → honest message, no throw, no fabrication.
 *
 *  INFERENCE_PROVIDER = none | replicate | selfhosted  (default: none)
 *  (`huggingface` is no longer accepted — see registry.ts / ISS-104.)
 */

import { MODEL_REGISTRY, type ModelEntry, type ConfiguredProvider, type InferenceProvider, type NormalizedOutput, type InferenceError } from './registry'
import { infer as replicateInfer } from './providers/replicate'
import { infer as selfhostedInfer } from './providers/selfhosted'

// ---------------------------------------------------------------------------
// Cache key helper (B6 — deep model caching)
// ---------------------------------------------------------------------------

/**
 * Stable cache key for inference results — keyed by (model, aoiSignature, prompt).
 * Pass the result to `cachedFetchJson` so expensive GPU calls are never repeated
 * for the same AOI + model + prompt within the same process lifetime.
 */
export function makeInferenceCacheKey(
  modelKey: string,
  aoiKey: string,
  prompt?: string,
): string {
  const promptPart = prompt ? `:${encodeURIComponent(prompt).slice(0, 80)}` : ''
  return `inference:${modelKey}:${aoiKey}${promptPart}`
}

// ---------------------------------------------------------------------------
// Provider configuration detection
// ---------------------------------------------------------------------------

function isProviderConfigured(provider: ConfiguredProvider): boolean {
  switch (provider) {
    case 'replicate':   return !!(process.env.REPLICATE_API_TOKEN?.trim())
    case 'selfhosted':  return !!(process.env.INFERENCE_ENDPOINT?.trim())
  }
}

/** Auto-detection order. HuggingFace was first here and is now gone (ISS-104):
 *  it serves none of these models, and because HF_API_TOKEN is set on a normal
 *  install for weight downloads, having it first meant the gateway routed to a
 *  dead backend instead of to Replicate or a self-hosted endpoint that works. */
const AUTO_ORDER: ConfiguredProvider[] = ['replicate', 'selfhosted']

/**
 * Resolve which provider to use for a given model entry.
 *
 * Mirrors `resolveTitilerBase()` / `isGeePreferred()`: explicit env override wins,
 * otherwise auto-detect from available credentials. Returns 'none' when nothing
 * is configured — never throws, never fabricates.
 */
export function resolveInferenceProvider(entry: ModelEntry): InferenceProvider {
  const explicit = (process.env.INFERENCE_PROVIDER || '').toLowerCase() as InferenceProvider

  // Explicit override: respect it if (a) it's a real provider, (b) the model has a
  // route for it, and (c) the credentials are actually present.
  if (explicit && explicit !== 'none') {
    const p = explicit as ConfiguredProvider
    if (entry.routes[p] && isProviderConfigured(p)) return p
    // Explicit but not satisfiable → still return none (don't silently fall through
    // to another provider the operator didn't ask for).
    return 'none'
  }

  // Auto-detect: first provider that has both a route for this model AND credentials.
  for (const p of AUTO_ORDER) {
    if (entry.routes[p] && isProviderConfigured(p)) return p
  }

  return 'none'
}

// ---------------------------------------------------------------------------
// Dispatch to provider client
// ---------------------------------------------------------------------------

function dispatchToProvider(
  provider: ConfiguredProvider,
  route: string,
  input: Record<string, unknown>,
  entry: ModelEntry,
): Promise<NormalizedOutput> {
  switch (provider) {
    case 'replicate':   return replicateInfer(route, input, entry)
    case 'selfhosted':  return selfhostedInfer(route, input, entry)
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run inference for a registered model.
 *
 * Returns `NormalizedOutput` on success, or `InferenceError` when:
 *  - no backend is configured (error: 'no_provider') — the honest degrade path
 *  - the model key is unknown (error: 'unknown_model')
 *  - the provider throws (error: 'provider_error')
 *
 * Never throws. Never fabricates output.
 */
export async function runInference(
  modelKey: string,
  input: Record<string, unknown>,
): Promise<NormalizedOutput | InferenceError> {
  const entry = MODEL_REGISTRY[modelKey]
  if (!entry) {
    return {
      error: 'unknown_model',
      honestMessage:
        `No model is registered for key "${modelKey}". ` +
        `Available models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
    }
  }

  const provider = resolveInferenceProvider(entry)

  if (provider === 'none') {
    return {
      error: 'no_provider',
      honestMessage:
        `No inference backend is configured for "${entry.key}" (${entry.task}). ` +
        `To enable it, set INFERENCE_PROVIDER=replicate|selfhosted in .env ` +
        `and the corresponding credentials (REPLICATE_API_TOKEN / INFERENCE_ENDPOINT), ` +
        `then restart the server. ` +
        `This analysis continues without ML inference — ` +
        `${entry.resolutionLimit}`,
    }
  }

  const route = entry.routes[provider]!
  try {
    return await dispatchToProvider(provider, route, input, entry)
  } catch (err: any) {
    return {
      error: 'provider_error',
      honestMessage:
        `Inference via ${provider} failed for "${entry.key}": ` +
        `${err?.message ?? 'unknown error'}. ` +
        `Check the provider credentials and endpoint, then retry.`,
    }
  }
}
