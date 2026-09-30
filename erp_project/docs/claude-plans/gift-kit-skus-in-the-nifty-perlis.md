# Gift-kit recipes: component SKUs as recipe lines

## Context

Seven SKUs carry `sku_type = 'Gift Kit'`; six of those are `subcategory = 'Kit'` with
`filling_uom = 'units'`, where `master_skus.filling` is the **component count** — "Body
Bliss Discovery Gift Set" is `filling = 7 units`, "Floral-Fresh & Luxe Body Care Duo" is
`2`. A kit is not manufactured from raw material: it is *assembled from other SKUs*.

The recipe wizard has no notion of this. It demands at least one RM line and that the RM
percentages total 99.5–100.5%, so a gift kit cannot be given a recipe at all today — and
indeed **no gift kit has one**. This is greenfield: nothing to migrate.

The change: when the wizard's chosen SKU is a gift kit, offer a **Kit contents** section
that picks other SKUs with a unit quantity, keep RM optional rather than required, and on
approval also record each component in `sku_variants` with the kit as parent.

Decisions taken (2026-09-09):
- Kit test is `sku_type = 'Gift Kit'` **AND** `subcategory = 'Kit'` — excludes
  `MCaf208_WB`, a body wash mistyped as a Gift Kit.
- The kit ↔ component link goes in **`sku_variants`** (`parent_sku_id` = kit,
  `variant_sku_id` = component). `base_sku_sno` / `is_base_sku` are **not touched**.
- **No costing roll-up in this change.** A kit prices at its own RM+PM only; component
  lines cost nothing. A kit therefore reads as uncosted rather than mispriced.

## Why not the real variant family

The obvious-looking route — give the kit its components' `(brand, base_sku_sno)` — is a
trap, and worth recording so nobody tries it later. Family membership is exactly that
column pair (`skus.selectVariantFamilyBySkuId`, `lib/queries/skus.ts:201`), and the
codebase enforces **one shared `rm_version` and identical RM across every active recipe in
a family** at four doors (`create-full`'s `rm_locked`, `createRecipeVersion`,
`propagateRmToVariants`, `update-status`'s `variant_rm_drift`). A kit joining its
components' family would put that invariant permanently in violation: the components
already differ from each other, `rmLineageHead` would silently elect one and mark the rest
outliers, and the kit's own recipe could never be re-activated. `sku_variants` is a
separate, directed, currently-empty table — it collides with none of that.

## The shape of the change

**`mtrl_type` gains a third value.** `details_recipe.mtrl_type` is `ENUM('rm','pm')` and
`mtrl_id` is a bare int whose meaning depends on it (no FK). A kit component is
`mtrl_type = 'sku'`, `mtrl_id = master_skus.id`, `amount` = unit count, `uom = 'units'`.
That is one migration plus a careful sweep of every reader.

**The kit test is resolved server-side.** A pure `isKitSku({ sku_type, subcategory })` in
`lib/masters/kit-sku.ts` is the single definition, used by the client for the UI and
re-resolved by the route from the DB row — the client declaring itself a kit is never
trusted, mirroring how `create-full` already re-resolves `resolveRmLock`
(`app/api/v1/masters/recipe-master/route.ts:150`). The wizard already receives full `Sku`
rows (`skus: Sku[]`, which carry `sku_type` and `subcategory`), so the UI needs no new
fetch and `check-existing` needs no new field.

### Phases

| Phase | What | Gate |
|---|---|---|
| **0** | `prisma/alter_details_recipe_mtrl_type_sku.sql` — `MODIFY COLUMN mtrl_type ENUM('rm','pm','sku') NOT NULL` on **`details_recipe` and `history_recipe`**. Apply to both schemas; sync `prisma/schema.prisma` (`details_bom` / `history_bom`, still under pre-rename names). | `SHOW COLUMNS` on both schemas shows three values. Nothing else ships until this is applied — MySQL rejects an unknown enum value and **rolls back the whole transaction**. |
| **1** | `lib/masters/kit-sku.ts` — pure `isKitSku()`. Unit tests. | `npm test` |
| **2** | **Close every door a third type opens** (below). No new feature yet; existing behaviour unchanged. | `npm test`, and a kit-less recipe still saves and still costs identically. |
| **3** | Validation: `sku_lines` on `bomCreateFullSchema`, RM made conditional. | Unit tests on the schema for both shapes. |
| **4** | Route: `create-full` stages `line:sku:<id>:*` items; approval handler inserts the lines and reconciles `sku_variants`. | `tests/db` — submit → approve → `details_recipe` has the `sku` rows and `sku_variants` matches. |
| **5** | Wizard UI: the Kit contents section, kit-aware step flow. | Create a real kit recipe end to end in the app. |

Phase 2 before 3–5 is deliberate: the readers must be safe against a `'sku'` row *before*
one can exist.

### Phase 2 — the doors

Two kinds of fix. **Costing must exclude the new type explicitly**, because every one of
these paths branches `mtrl_type === "rm" ? rmCost : pmCost` and would route a component SKU
into the **PM** branch, look `mtrl_id` up in the PM rate map, miss, and price it at zero —
the exact silent-zero class `CLAUDE.md` warns about for `bom_misc`:

- `app/manufacturing/[mfgId]/costing-breakup.ts:71`
- `app/manufacturing/[mfgId]/page.tsx:327`
- `app/api/v1/manufacturing/[mfgId]/final-costing/detailed-export/route.ts:138,184-200`
- every `details_recipe` read in `lib/queries/manufacturing.ts` — add `AND mtrl_type IN
  ('rm','pm')` at the SQL, so the exclusion holds even for a caller added later

**Recipe display and edit must genuinely handle it:**

- `app/masters/recipe-master/useRecipeDetailPanel.ts` — **the worst door, read and
  confirmed.** `:163` casts `(l.mtrl_type as "rm" | "pm") ?? "rm"`, `:169-170` seed only
  `editRmRows`/`editPmRows`, `:206` shows only `rmLines`/`pmLines`, and the save at
  `:348-349` posts only `rm_lines` and `pm_lines`. So a `'sku'` line would be invisible on
  the panel and then **silently deleted from the recipe** by any edit-and-save there,
  leaving an approved gift kit with no contents. Needs a third row array carried all the way
  through that submit.
- `lib/queries/recipe.ts` — `selectDetailLinesByBomId` and its siblings `LEFT JOIN
  master_rm … AND mtrl_type='rm'` / `master_pm …`; add the matching `LEFT JOIN master_skus
  … AND mtrl_type='sku'` and `COALESCE` the code/name so a component renders instead of a
  blank.
- `lib/approvals/handlers/recipe.ts` — `RecipeLine`/`StoredRecipeLine` types (`:109,112`)
  and the `line:<type>:<id>:<field>` parser widen to `rm|pm|sku`.
- `app/masters/recipe-master/recipe-csv.ts` — the **dump** (`:47` `typeRank`, `:50`) must
  emit `sku` lines. The **parse** (`:89`) and the bulk path
  (`route.ts:511`) stay `rm`/`pm` only: kits are manual-entry only for now, which is also
  why Step 3 hides the CSV option for a kit.

### Phase 2 addendum — three doors the first pass missed

A follow-up audit of every reader turned up three more, two of them silent-drop bugs of the
same family as the detail panel:

1. **`app/approvals/approval-card/RecipeLineDiffTable.tsx:106` carries its own copy of the
   `/^line:(rm|pm):(\d+):(.+)$/` regex**, independent of the handler's. Left alone, an
   approver reviewing a kit recipe would see every RM/PM change and **no component changes
   at all** — approving a diff that doesn't show what it contains. Both regexes widen
   together, and `app/approvals/material-map.ts`'s `buildMaterialMap` needs a `sku` bucket
   or the card renders `#42` instead of the component's code.
2. **`diffBomLines` (`lib/masters/recipe-version.ts:82-98`) builds only rm/pm sets**, so a
   change to *only* the component list registers as no change at all: `pm_version` does not
   bump and two recipes with different contents get the **same `bom_code`**. See the
   decision below.
3. **Costing is one choke point, not five.** `manufacturingSql.selectBomLineDetailByMfg`
   (`lib/queries/manufacturing.ts:610-627`) feeds `costing-breakup.ts`, `[mfgId]/page.tsx`
   and `detailed-export/route.ts`; its `CASE WHEN mtrl_type='rm' … ELSE p.pm_code END`
   routes a `'sku'` row into the PM branch, and since `master_skus.id` and `master_pm.id`
   are independent sequences, a collision would price a component at an unrelated PM's rate.
   Filtering `mtrl_type IN ('rm','pm')` in **that one query** fixes all three consumers, so
   the ternaries stay untouched. `selectMaterialCostByMfg` is already safe by construction
   (explicit `CASE WHEN 'rm' … WHEN 'pm'`) and must **not** be converted to a `WHERE`
   filter — that would change the zero-cost semantics a pure-kit recipe depends on.

Also confirmed dropping `'sku'` lines the same way as the detail panel:
`useRecipeHistoryPanel.ts:99-100`. And `selectAllFiltered` (`recipe.ts:132`) and
`selectHistoryLinesByBomId` (`recipe.ts:672`) need the `master_skus` join alongside
`selectDetailLinesByBomId`, or the export and History panel show blanks.

**Version-numbering decision (mine, flagged for override):** a component-set change counts
as a **PM-side change** — `diffBomLines` gains a third set folded into `pmChanged`, so
`pm_version` bumps and `bom_code` keeps its `<sku>-RM<n>-PM<n>` format. Composition is
SKU-scoped exactly as PM is, and the alternative — a third `-SK<n>` segment — changes a
user-visible identifier and every place that parses or displays it. `bomChangeTypeSchema`
gains `"sku"` so the change-type checkbox can honestly read "Kit contents" rather than
making someone tick "PM".

### Phase 3 — validation

`bomLineSchema`'s `mtrl_type` becomes `z.enum(["rm","pm","sku"])`; add
`sku_lines: z.array(bomLineSchema).default([])`. The two rules that block kits move out of
the unconditional `superRefine`:

- `rm_lines` loses `.min(1)`; "at least one RM line" and the 99.5–100.5% total are enforced
  **only when the SKU is not a kit**. The schema cannot know — it holds `sku_id`, not the
  SKU row — so both become route-side checks where the row is already in hand, next to the
  existing `rm_locked` re-resolve. `RM_TOTAL_MIN/MAX` and `isRmTotalValid` stay the single
  source of truth for the non-kit path.
- A non-kit SKU submitting `sku_lines` is a 400. A kit with zero `sku_lines` is a 400.

Component guards, all route-side:
- every component `sku_id` through `assertSkuIdInBrandScope` — components are other SKUs and
  the caller may not hold their brand;
- no self-reference, and a component may not itself be a kit (no nesting, no cycles);
- no duplicate component in one recipe.

The declared count (`master_skus.filling`) is shown against the running total in the wizard
as a **warning, not a block** — the wizard's existing RM-total banner is the pattern. Say so
if you want it hard.

### Phase 4 — write path

`create-full` stages `line:sku:<sku_id>:__present__` / `:amount` / `:uom` exactly like
rm/pm, so the whole existing submit → approve → insert machinery carries it with no new
mechanism. `details_recipe` rows are still only written in `bomHandler.applyAndArchive`.

`sku_variants` is reconciled **there too, not at submit** — the composition is not real
until approved. Delete the kit's rows, insert one per `'sku'` line
(`parent_sku_id` = kit, `variant_sku_id` = component, `sku_code` = component code,
`size` = component `filling` + `filling_uom`). New SQL in `lib/queries/skus.ts`. The table's
`@@unique([parent_sku_id, variant_sku_id])` makes that safe; it has no `status` column, so
removal is a delete.

> ⚠️ **Nothing reads `sku_variants` today** — after this it is written but not displayed.
> The composition *is* visible on the recipe detail panel, so this is not a dead end, but if
> you want "which kits is this SKU in?" on the SKU master, that is a small follow-on in
> `SkuVariantsDialog.tsx` and I'd rather do it deliberately than guess.

### Phase 5 — wizard

- `useRecipeWizard.ts`: `skuRows` state beside `rmRows`/`pmRows`; `isKit` derived from the
  picked `Sku` via `isKitSku`; `canProceedFromLines` accepts a kit with zero RM lines and
  ≥1 component; `handleSubmit` sends `sku_lines`.
- `RecipeWizardSteps.tsx` Step 4: a third `LineSection` — **Kit contents** first, then RM
  ("optional for a kit"), then PM. Step 3 offers Manual only for a kit.
- `RecipeLineEditorGrid.tsx` is reused as-is by mapping SKUs into its existing
  `RecipeMaterialOption` shape (`id`, code, name, `uom: "units"`); `defaultUom` learns
  `sku → "units"`. No new grid component.
- Step 5 review lists the components and the declared-vs-actual unit count.

## Files

```
prisma/alter_details_recipe_mtrl_type_sku.sql            (new migration, both schemas)
prisma/schema.prisma                                      (enum sync only)
lib/masters/kit-sku.ts                                    (new, pure)
lib/validation/recipe.ts                                  (sku_lines; RM rules conditional)
lib/queries/recipe.ts                                      (join master_skus for sku lines)
lib/queries/manufacturing.ts                               (mtrl_type IN ('rm','pm'))
lib/queries/skus.ts                                        (sku_variants replace/insert)
lib/approvals/handlers/recipe.ts                            (third type through the parser)
app/api/v1/masters/recipe-master/route.ts                   (kit branch, component guards)
app/masters/recipe-master/useRecipeWizard.ts                (skuRows, isKit)
app/masters/recipe-master/RecipeWizardSteps.tsx             (Kit contents section)
app/masters/recipe-master/RecipeLineEditorGrid.tsx          (defaultUom for sku)
app/masters/recipe-master/useRecipeDetailPanel.ts           (third array, don't drop lines)
app/masters/recipe-master/recipe-csv.ts                     (dump only)
app/manufacturing/[mfgId]/costing-breakup.ts                (exclude sku)
app/manufacturing/[mfgId]/page.tsx                          (exclude sku)
app/api/v1/manufacturing/[mfgId]/final-costing/detailed-export/route.ts  (exclude sku)
tests/unit/kit-sku.test.ts                                  (new)
tests/unit/recipe-validation.test.ts                        (kit vs non-kit shapes)
tests/db/recipe-kit.test.ts                                 (new: submit → approve → rows)
```

## Verification

1. `npm test` — `isKitSku` on all 7 real gift-kit rows plus the mistyped `MCaf208_WB`
   (must be false); the schema accepting a kit with no RM and rejecting a non-kit with
   `sku_lines`; the RM-total rule still firing for a normal SKU.
2. `npm run test:db` — `tests/db/recipe-kit.test.ts`: stage a kit recipe, approve it, assert
   `details_recipe` holds the `'sku'` rows and `sku_variants` matches the composition;
   re-approve a changed composition and assert the old rows are gone.
   **Needs the Phase 0 ALTER applied to `DB_NAME_TEST` first.**
3. `npx tsc --noEmit --incremental false` and `npm run lint:changed`.
4. **Regression, the important one:** open an existing non-kit recipe with costing — e.g. a
   `Main Unit` SKU on a manufacturer with agreed rates — and confirm Agreed Final Costing
   and the detailed export produce byte-identical numbers to before. That is what proves the
   Phase 2 exclusions didn't change the costing base.
5. In the app: create a recipe for `MCFGKIT0087F0007_S` (Body Bliss, declared 7 units) with
   7 components and no RM; approve it; confirm the detail panel shows the components, the
   kit reads as uncosted rather than zero-cost, and `sku_variants` has 7 rows parented to it.
