/**
 * Builder for `extraction_config` — the object Nanonets receives on
 * /api/v2/extract/sync.
 *
 * Staged rather than a plain literal because a per-manufacturer strategy needs
 * to layer its quirks onto a shared base without either side knowing what the
 * other set. A closure, not a class: nothing else in lib/ is a class, and the
 * fluent surface is the only thing a class would have bought.
 *
 * Each call starts from a deep copy of the base schema, so a strategy can never
 * leak a description into the next request's config.
 */

import { EXTRACTION_SCHEMA } from "./schema"
import { BASE_INSTRUCTIONS, MAX_INSTRUCTION_CHARS } from "./instructions"

type FieldSchema = { type: string; description?: string }
type LineItemsSchema = { type: string; items: { type: string; properties: Record<string, FieldSchema> } }
type SchemaShape = { type: string; properties: Record<string, FieldSchema | LineItemsSchema> }

export type ExtractionConfig = {
  output_format: "json"
  json_options: SchemaShape
  custom_instructions: string
  prompt_mode: "append"
}

export interface ExtractionConfigBuilder {
  /** Replace a top-level field's description. Throws on an unknown field. */
  describeField(key: string, description: string): ExtractionConfigBuilder
  /** Replace a line_items field's description. Throws on an unknown field. */
  describeLineField(key: string, description: string): ExtractionConfigBuilder
  /** Append rules after the shared base ones, in order. */
  addRules(rules: string[]): ExtractionConfigBuilder
  build(): ExtractionConfig
}

export function extractionConfig(): ExtractionConfigBuilder {
  const schema = structuredClone(EXTRACTION_SCHEMA) as unknown as SchemaShape
  const rules: string[] = [...BASE_INSTRUCTIONS]

  const lineItems = schema.properties.line_items as LineItemsSchema
  const lineProps = lineItems.items.properties

  // Unknown keys throw rather than no-op. A typo'd field name is otherwise
  // invisible: the config still builds, the call still succeeds, and the
  // manufacturer's quirk is simply never communicated.
  function fieldOf(bag: Record<string, unknown>, key: string, where: string): FieldSchema {
    const field = bag[key]
    if (!field) {
      throw new Error(
        `extractionConfig: no ${where} field "${key}". Known: ${Object.keys(bag).join(", ")}`
      )
    }
    return field as FieldSchema
  }

  const api: ExtractionConfigBuilder = {
    describeField(key, description) {
      if (key === "line_items") {
        throw new Error('extractionConfig: use describeLineField() for line_items fields')
      }
      fieldOf(schema.properties, key, "header").description = description
      return api
    },

    describeLineField(key, description) {
      fieldOf(lineProps, key, "line_items").description = description
      return api
    },

    addRules(extra) {
      rules.push(...extra)
      return api
    },

    build() {
      const custom_instructions = rules.join(" ")
      if (custom_instructions.length > MAX_INSTRUCTION_CHARS) {
        throw new Error(
          `extractionConfig: custom_instructions is ${custom_instructions.length} chars, ` +
          `over the ${MAX_INSTRUCTION_CHARS} limit. Trim a strategy's rules.`
        )
      }
      return {
        output_format: "json",
        json_options: schema,
        custom_instructions,
        prompt_mode: "append",
      }
    },
  }

  return api
}
