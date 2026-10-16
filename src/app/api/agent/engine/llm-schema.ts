import { z } from 'zod'

/** JSON Schema for the model, from the zod params: the single source of the argument contract.
 *  Kept inside the subset every provider accepts (Gemini's is the narrowest): no `$schema`,
 *  `$ref`, `additionalProperties`, `default`, `const`, `anyOf` or empty nested objects; the
 *  portability unit test walks every schema. */
export function toLlmSchema(params: z.ZodObject<any>): Record<string, any> {
  const schema = z.toJSONSchema(params, { io: 'input', target: 'draft-7', unrepresentable: 'throw' }) as Record<string, any>
  delete schema.$schema
  delete schema.additionalProperties
  schema.properties ??= {}
  schema.required ??= []
  return schema
}
