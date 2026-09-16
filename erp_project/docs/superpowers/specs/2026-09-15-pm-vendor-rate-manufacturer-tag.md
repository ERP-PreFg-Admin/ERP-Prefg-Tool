# A manufacturer tag on PM × Vendor rates

> Status: **implemented 2026-09-15**. Migration applied to dev; **prod still
> outstanding** — `add_pm_ven_mfg_id.sql` is not re-runnable.
> Sibling change already agreed: the Manufacturer column comes **off** the RM
> by-vendor table (display only — the RM tag itself stays).

## The problem, in one line

`/masters/packing-materials?view=vendor` has no Manufacturer column, and cannot
have one: `cost_master_pm_ven` has no `mfg_id`. `cost_master_rm_ven` does.

## What the asymmetry costs today

The gap is not an oversight that drifted in — it is **written down in three
places** as a deliberate skip, and each is a place this plan has to touch:

| | |
|---|---|
| `lib/master-routes/material-utils.ts:284-286` | `...(moduleVrm === "RM_VRM" ? [["mfg_id", …]] : [])` — the edit diff skips the field for PM |
| `lib/approvals/handlers/packing-materials.ts:264` | "cost_master_pm_ven has no mfg_id column (unlike cost_master_rm_ven), so there's no manufacturer tag here" |
| `prisma/schema.prisma:995` | `pm_vrm_dynamic` has no `mfg_id`; `rm_vrm_dynamic:1053` has `mfg_id Int?` |

So this is a **mirror**, not a design. Every decision has already been made once
on the RM side; the risk is missing one of its five limbs, not choosing wrong.

## What the tag actually is

Informational, nullable, **not** part of the rate's identity. `checkVendorRate`
keys on `(rm_id, vendor_id, moq)` — `mfg_id` is not in it, so tagging a rate
never forks it into a second row. Treat it the same way on PM or the uniqueness
grain changes underneath the rate history.

---

## Sequencing

Four steps. Each lands on its own; nothing before step 3 is visible to a user.

**1 — DDL, dev schema only.**
`prisma/add_pm_ven_mfg_id.sql`, with the usual what/why/re-runnable header. One
nullable column plus its index, mirroring `rm_vrm_dynamic`. **Not re-runnable** —
MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`; the header must say so.
Then **stop**. Prod gets its own go-ahead, separately, after step 4 is verified
on dev.
`prisma/schema.prisma` `pm_vrm_dynamic` gains `mfg_id Int?` in the same commit —
schema-only, but it is the file the next person greps.

**2 — Read path.** `mfg_id`, `mfg_name`, `mfg_code` onto
`packingMaterials.selectVendorPaginated` / `selectVendorAllFiltered` (and
`selectVendorRateById`, which the approval handler reads), each with
`LEFT JOIN master_mfgs AS mm ON mm.id = pmv.mfg_id` — copy
`lib/queries/raw-materials.ts:216-223` verbatim, `rmv`→`pmv`, `r`→`p`.
`LEFT`, not `INNER`: an untagged rate must not vanish from the list.
Nothing renders it yet, so this cannot regress the table.

**3 — Write path, and the gate.** Three edits that must land *together* —
the dialog writes the field, the diff carries it, the handler applies it. Any two
of the three ships a Manufacturer dropdown whose value silently never persists:

- `packingMaterials.insertVendorRate` / `updateVendorRate` gain the column
  (`raw-materials.ts:458,518` is the shape).
- `material-utils.ts:286` — drop the `moduleVrm === "RM_VRM"` condition; the
  field is now real on both, so the ternary and its comment both go.
- `pmVrmHandler.applyAndArchive` (`handlers/packing-materials.ts:65-72`) gains
  the `fieldMap.mfg_id !== undefined ? (… ? Number(…) : null) : cur.mfg_id`
  argument, exactly as `rmVrmHandler` (`handlers/raw-materials.ts:65`).
- `EditPmVendorRateDialog.tsx` gains `manufacturers: Mfg[]` and the `<Select>`
  from `EditRmVendorRateDialog.tsx:207-220`, plus `mfg_id` in the `add-rates`
  body. `VendorPackingMaterialsClient.tsx:140` already holds `manufacturers` —
  it is passed in at `page.tsx:111`, so nothing new has to be fetched.

**4 — The column.** One line in `VendorPackingMaterialsClient.tsx`, mirroring
what is being deleted from `VendorRawMaterialsClient.tsx:35`, placed after
Vendor:

```tsx
{ key: "mfg_name", label: "Manufacturer", sortAs: "text", render: (r) => (r.mfg_name as string | null) ?? "—" },
```

`PMVendor` in `types/masters.ts` gains `mfg_id`, `mfg_name`, `mfg_code`.

---

## Deliberately out of scope

- **CSV bulk.** `pm-vrm-bulk-fields.ts` gains no `mfg_code` column, and
  `pmVrmBulkHandler` no lookup. RM's version costs a `mfgSql.selectByCode` round
  trip per row (`vrm-bulk/route.ts:167-168`) for a field nothing reads. Add it
  when someone asks to bulk-tag, not before.
- **A filter on the column.** Sort only, like RM.
- **Backfill.** Every existing PM vendor rate reads `—`. There is no source to
  backfill *from*; the tag is hand-entered.

## Known wart, inherited not introduced

The approval card renders the diff's `mfg_id` as a **bare integer** — nothing in
`app/approvals/` maps it to a name. It is already wrong for RM_VRM; mirroring it
makes it wrong twice. Fixing it is one entry in `app/approvals/material-map.ts`
and is worth folding into step 3, but it is not required for the column to work.

## Risk

| | |
|---|---|
| Step 3 splitting across commits | A dropdown that saves nothing. Land the four edits as one. |
| `INNER JOIN` slipping in at step 2 | Every untagged rate disappears from the vendor table. `LEFT`, always. |
| Prod DDL riding along | Step 1 is **dev only**. Prod is a separate ask. |
| `mfg_id` leaking into `checkVendorRate` | Would fork one rate into one row per manufacturer. It stays out of the key. |

## Verification

- `npm run lint:changed`, `npx tsc --noEmit --incremental false`.
- Dev, by hand: tag a PM vendor rate → approve it → the column shows the name;
  an untagged rate still lists and still reads `—`; editing only the rate on a
  tagged row leaves the tag intact (that is the `: cur.mfg_id` fallback).
- No unit test — there is no pure logic here, only SQL and a `<Select>`.
