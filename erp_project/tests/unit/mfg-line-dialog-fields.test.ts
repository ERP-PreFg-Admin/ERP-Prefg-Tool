// Every field the manufacturing-line API accepts must have an input in the
// dialog that submits it.
//
// The regression this catches: LineDialog kept `status`, `effective_to`,
// `monthly_capacity`, `this_month_plan`, `last_batch_date` and `remarks` in its
// FormState, populated them from `editData`, and POSTed all six — but rendered
// JSX for none of them. The whole dialog body sat behind `!editData`, so opening
// it on an existing line showed a title, blank space and two buttons. Add mode
// hid the same hole: those six silently posted their defaults.
//
// Field list comes from the Zod schema, not a copy, so adding a field to the API
// and forgetting the input fails here instead of shipping an unreachable field.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createMfgLineSchema, updateMfgLineSchema } from "../../lib/validation/manufacturing"

const DIALOG = join(process.cwd(), "app", "manufacturing", "[mfgId]", "LineDialog.tsx")

/** Payload keys, minus the ones the dialog derives rather than collects. */
const DERIVED = new Set(["action", "id", "mfg_id", "recipe_id"])

const fieldsOf = (shape: Record<string, unknown>) =>
  Object.keys(shape).filter((k) => !DERIVED.has(k))

test("the dialog collects every field the update action accepts", () => {
  const src = readFileSync(DIALOG, "utf8")
  const missing = fieldsOf(updateMfgLineSchema.shape).filter((f) => !src.includes(`set("${f}"`))

  assert.deepEqual(
    missing, [],
    `updateMfgLineSchema accepts these but LineDialog has no input writing them: ${missing.join(", ")}`
  )
})

test("the dialog collects every field the create action accepts", () => {
  const src = readFileSync(DIALOG, "utf8")
  // recipe_id is derived: add mode collects recipe_ids (plural) and posts one
  // request per pick, so it is exempted above.
  const missing = fieldsOf(createMfgLineSchema.shape).filter((f) => !src.includes(`set("${f}"`))

  assert.deepEqual(
    missing, [],
    `createMfgLineSchema accepts these but LineDialog has no input writing them: ${missing.join(", ")}`
  )
})
