/** Prompt size before/after the shortlist and prompt restructuring, counted by the Gemini tokenizer (countTokens is free).
 *  `before` needs a copy of the earlier prompt builder at src/app/api/agent/old_prompt_tmp.ts (not committed).
 *    npx vite-node --config vitest.config.ts scripts/perf/prompt-tokens.mts */
import '../../eval/planner/env'
import { GoogleGenAI } from '@google/genai'
import { getToolDefinitions } from '../../src/app/api/agent/engine/registry'
import { shortlistOperations } from '../../src/app/api/agent/engine/shortlist'
import { buildPrompt } from '../../src/app/api/agent/prompt'
import { buildPrompt as buildOld } from '../../src/app/api/agent/old_prompt_tmp'
import { SUBMIT_PLAN_TOOL } from '../../src/app/api/agent/lib/plan'

const key = process.env.GEMINI_API_KEY
if (!key) throw new Error('GEMINI_API_KEY is not set')
const ai = new GoogleGenAI({ apiKey: key })
const MODEL = process.env.TOKEN_MODEL ?? 'gemini-2.5-flash'
const aoi = { type: 'Polygon', coordinates: [[[36.80, -1.30], [36.82, -1.30], [36.82, -1.28], [36.80, -1.28], [36.80, -1.30]]] }
const questions = [
  'How much of this area flooded during the 2024 monsoon (June to September)? How many buildings were affected?',
  'Show me NDVI for this area.',
  'What were the daily maximum temperatures here in July 2023?',
]
const decls = (tools: any[]) => [{ functionDeclarations: tools.map((t: any) => ({ name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters })) }]
/** countTokens on the Developer API accepts neither systemInstruction nor tools, so the three parts are counted as
 *  text: the system prompt, the tool declarations as JSON (close to how they reach the model) and the question. */
async function tokens(text: string) {
  const r = await ai.models.countTokens({ model: MODEL, contents: [{ role: 'user', parts: [{ text }] }] })
  return r.totalTokens ?? 0
}
async function count(system: string, tools: any[], q: string) {
  return (await tokens(system)) + (await tokens(JSON.stringify(decls(tools)))) + (await tokens(q))
}
const all = getToolDefinitions()
for (const q of questions) {
  const names = shortlistOperations(q).names
  const sub = all.filter((t: any) => t.function.name === SUBMIT_PLAN_TOOL || names.includes(t.function.name))
  const before = await count(buildOld(aoi, 'en'), all, q)
  const after = await count(buildPrompt(aoi, 'en', undefined, undefined, undefined, names), sub, q)
  console.log(`${q.slice(0, 60)}... | before ${before} | after ${after} | ${(100 * (1 - after / before)).toFixed(0)}% fewer | offered ${names.length} of ${all.length - 1}`)
}
process.exit(0)
