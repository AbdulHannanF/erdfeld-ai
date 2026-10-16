/** Loading recipes from `recipes/<id>@<semver>.yaml`.
 *
 *  The file name is the identity: `recipes/not_cleared_since@1.0.0.yaml` must declare the same id
 *  and version. A recipe, once released, is not edited: a change of any threshold is a new
 *  version file, and cases store `id@version`. `latest` is the highest semver of an id.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import yaml from 'js-yaml'

import { templateNames } from './rule'
import { RecipeSchema, recipeKey, type Recipe } from './schema'

export const recipesDir = () => process.env.RECIPES_DIR || path.join(process.cwd(), 'recipes')

const FILE = /^([a-z][a-z0-9_]*)@(\d+\.\d+\.\d+)\.ya?ml$/

export const compareSemver = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Parse and check one recipe's text. Throws an Error naming every problem. */
export function parseRecipe(text: string, fileName?: string): Recipe {
  let raw: unknown
  try {
    raw = yaml.load(text)
  } catch (err) {
    throw new Error(`${fileName ?? 'recipe'}: not valid YAML (${(err as Error).message.split('\n')[0]})`)
  }
  const parsed = RecipeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${fileName ?? 'recipe'}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'recipe'}: ${i.message}`).join('; ')}`)
  }
  const recipe = parsed.data
  const problems: string[] = []
  const m = fileName ? FILE.exec(path.basename(fileName)) : null
  if (fileName && (!m || m[1] !== recipe.id || m[2] !== recipe.version)) {
    problems.push(`the file name must be ${recipe.id}@${recipe.version}.yaml (it is ${path.basename(fileName)})`)
  }
  const known = new Set([...Object.keys(recipe.params), ...Object.keys(recipe.derived), ...Object.keys(recipe.decision.inputs)])
  const referenced = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => referenced(x, out))
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.param === 'string' && Object.keys(o).length === 1) out.push(o.param)
      else if (typeof o.ref === 'string' && Object.keys(o).length === 1) out.push(o.ref)
      else Object.values(o).forEach((x) => referenced(x, out))
    }
    return out
  }
  for (const name of referenced([recipe.plan, recipe.derived, recipe.decision])) {
    if (!known.has(name)) problems.push(`"${name}" is used but is not a parameter, derived value or decision input`)
  }
  const templates = [recipe.claim, recipe.decision.otherwise.reason, ...recipe.decision.rules.map((r) => r.reason)]
  for (const name of templates.flatMap(templateNames)) {
    if (!known.has(name)) problems.push(`the template uses {${name}}, which is not a parameter, derived value or decision input`)
  }
  if (problems.length) throw new Error(`${fileName ?? 'recipe'}: ${problems.join('; ')}`)
  return recipe
}

export interface RecipeCatalog {
  list(): Recipe[]
  /** `id` (latest) or `id@x.y.z`. */
  get(ref: string): Recipe | undefined
}

export function loadRecipes(dir = recipesDir()): RecipeCatalog {
  const recipes: Recipe[] = []
  let files: string[] = []
  try {
    files = readdirSync(/* turbopackIgnore: true */ dir).filter((f) => FILE.test(f))
  } catch {
    files = []
  }
  for (const f of files) recipes.push(parseRecipe(readFileSync(path.join(/* turbopackIgnore: true */ dir, f), 'utf8'), f))
  const keys = recipes.map(recipeKey)
  if (new Set(keys).size !== keys.length) throw new Error('Two recipe files declare the same id@version')
  return {
    list: () => [...recipes].sort((a, b) => a.id.localeCompare(b.id) || compareSemver(b.version, a.version)),
    get: (ref) => {
      const [id, version] = ref.split('@')
      const ofId = recipes.filter((r) => r.id === id)
      return version ? ofId.find((r) => r.version === version) : ofId.sort((a, b) => compareSemver(b.version, a.version))[0]
    },
  }
}

let shared: RecipeCatalog | undefined
/** The catalog of the running server, read once. */
export function defaultCatalog(): RecipeCatalog {
  return (shared ??= loadRecipes())
}
