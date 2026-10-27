# Choose the manufacturer unit on a PO

Status: plan, awaiting go-ahead. 2026-10-27.

## Context

NG Electro has two plants with different GSTINs:
- **MBA** (Plot 51 & 52, `…H1ZM`)
- **MB2** (Plot 36, `…H2ZL`)

Today the PO PDF's "To" block comes from `map_mfg_unit_sku`, which allows **one unit per (manufacturer, SKU)**. A PO has no unit of its own. So:

- **The raiser can't choose.** To raise a PO against the other plant, someone has to edit the SKU mapping in SQL. That's how `HYP-IMP-202610-001` was moved to MBA on 2026-10-26.
- **A remap rewrites unmailed POs.** The join reads the live mapping when it renders, so changing the mapping changes the PDF of every unmailed PO for that SKU.
- **There's no record of which plant was ordered from.** After mailing, it survives only in the cached PDF.

**Goal:** when a PO is raised for a manufacturer that has units, the raiser picks the unit, and the PO stores it. This works the same from Add PO and from the bulk CSV. The mapping becomes only the **default**.

This is generic to any manufacturer with rows in `details_mfg_unit`; NG Electro is the only one today. A manufacturer with no units behaves exactly as now.

## Sequencing and gates

| # | Step | Gate |
|---|---|---|
| 1 | **Migration on dev:** add `purchase_orders.mfg_unit_id INT NULL` with an FK to `details_mfg_unit`. **No backfill** (Ajay, 2026-10-27): it applies to POs raised from now on. Applied to dev 2026-10-27. | Prod only on its own go-ahead, **before** the deploy. |
| 2 | **Read side:** the PO PDF prefers the PO's own unit and falls back to the mapping. | The DB test: a PO with a unit prints that unit even when the mapping says the other plant. |
| 3 | **Add PO / Impromptu:** a "Supplier unit" select appears only when the chosen manufacturer has active units, pre-filled from the mapping. The server validates it. | Dev: raise a normal PO and an impromptu PO each way, then Review PDF. |
| 4 | **Bulk CSV:** a new optional `mfg_unit` column, checked at upload, preview and approval. | Dev: upload a file with blank, valid and wrong values. |
| 5 | **Follow-through:** split children, the Draft edit, PO Tracking display, export. | — |
| 6 | Prod migration, then deploy. | Ajay's go-ahead. |

**Progress 2026-10-27:** steps 1–5 built on dev, uncommitted. The PO export also carries a "Supplier Unit" column, which re-imports as `mfg_unit`. Not yet clicked through in a browser.

Steps 2–5 ship together as one deploy. Step 1 must reach prod first, because the code reads the new column.

## Design

### Data
- Add `purchase_orders.mfg_unit_id INT NULL`. NULL means "use the mapping" (the old behaviour), so old rows and units-less manufacturers need nothing.
- **No backfill.** Existing POs stay NULL and keep reading the mapping. On prod all 155 non-inward NG Electro POs were already mailed on 2026-10-27, so their PDFs are frozen in S3 and a remap can't change what was sent.
- `map_mfg_unit_sku` stays and becomes the **default** suggestion. No unique-key change is needed.
- **The rule, in one pure function** (`lib/po/po-unit.ts`), shared by the dialog, the API and bulk:
  1. If the manufacturer has no active units, the unit is NULL. Sending one is a 400 `unit_not_applicable`.
  2. If it has units, the chosen unit must be one of **that manufacturer's active units**; otherwise 400 `unknown_unit`. If none was chosen, use the mapping's default. If there's no mapping either, it's a 400 `unit_required`, because guessing a GSTIN on a legal document is worse than asking.

### PDF (`selectForEmail`, `lib/queries/purchase-orders.ts:1178`)
- Join `details_mfg_unit` on `COALESCE(po.mfg_unit_id, mus.unit_id)`. The split document uses the same query, so it follows automatically.
- **Mailed POs are unaffected.** The first send freezes the PDF in S3 (`poDocument`, `lib/mail/mailer.ts:163`). A unit can only change before mailing, which matches the edit rules below.

### Add PO / Impromptu (`AddPODialog.tsx`, `ImpromptuPODialog.tsx`)
- Each SKU row gets a **"Supplier unit"** select, shown only when the manufacturer has active units. It's per row because a mixed order can split across plants.
- Each option shows the unit code, the first line of the address and the GSTIN, e.g. "MBA — Plot 51 & 52 — …H1ZM".
- The select is pre-filled from the mapping, and a row with no mapping must be chosen by hand.
- **Where the data comes from:** the existing `/api/v1/purchase-orders/mfg-skus` response gains `units` (once per manufacturer) and `default_unit_id` (per SKU). No new endpoint is needed.
- **API:** `poCreateSchema` gains an optional `mfg_unit_id`. `route.ts` resolves it with the rule above and passes it to `insert` / `insertNormal`.
  - **Impromptu and special POs:** the unit is shown on the approval card as an approval item, so the approver sees the plant.

### Bulk CSV (`PO_BULK`)
- **New optional column `mfg_unit`**, holding the **unit code** (`MBA` / `MB2`), not an id. People type codes, and ids differ between dev and prod. It's added to `PO_BULK_CSV_FIELDS` (`po-bulk-fields.ts`) with the alias "Supplier Unit". The template legend lists the codes as `# mfg_unit: MBA | MB2`.
- **Blank:** the mapping default is used, the same as the dialog. Existing files and templates keep working unchanged.
- **At upload and preview** (`checkBulkRows`, `lib/po/po-bulk-check.ts`): it's resolved with the same rule, looking up units through `BulkFacts`, so a wrong code or `unit_required` is refused **at upload, with its row number**, not at approval. The resolved `mfg_unit_id` is written to the staged S3 file next to the price (`STAGED_PRICE_KEYS`), so the approver approves exactly what was resolved.
- **At approval** (`createBulkPoRow`): it reads the staged id and re-checks that the unit is still active, refusing with "upload again" if not, like the misc-cost re-plan.
- **Bulk update rows** (rows with an existing `po_no`): `mfg_unit` may change only while the PO is still **unmailed**, matching the rule that a mailed PO is frozen. It's ignored, with a warning, on a mailed PO.

### Follow-through
- **Split:** each child inherits the parent's unit when it keeps the same manufacturer. If a child moves to another manufacturer, it takes that manufacturer's default.
- **Draft edit (`PO_EDIT`, `lib/po/po-edit.ts:20`):** `mfg_unit_id` joins the editable fields, so a raised-but-unmailed PO can change plant through the existing approval. A stored `draft` can already be re-edited with `updateDraft`, which gains the column.
- **Invoice-inward POs:** these record goods already received, so the unit stays NULL, unchanged.
- **PO Tracking:** the unit code shows under the manufacturer name in the existing column (no new column), and it's added to the PO export.

### Units master (out of scope, noted)
Units are still edited by SQL only (`prisma/add_mfg_units.sql`). A Units tab on the Manufacturer master is the natural next step, but it isn't needed for this change.

## Risks
1. **Uniware sees one vendor.** The Uniware vendor for NG Electro is registered on the MBA GSTIN (`lib/uniware/vendor-registry.ts:23`), and the PO push sends only a vendor code. An MB2 order therefore lands in Uniware under MBA's GSTIN. That's true **today** and this change doesn't make it worse, but it should be decided whether MB2 needs its own Uniware vendor code.
2. **The prod migration must land before the deploy**, or every PO read fails on the missing column. The same rule held for `bom_misc`.
3. **Old POs follow the live mapping.** Without a backfill, a NULL PO's unit is whatever its SKU maps to now. That's harmless for mailed POs, whose PDF is frozen, but screens that show the unit will show the current mapping for old rows. Show it greyed or "default" for NULL rows so nobody reads it as recorded.
4. **Mixed orders.** One PO mail can cover rows for both plants. Each PO's PDF names its own unit, which is correct, but the cover mail is shared. That's acceptable unless the plants have separate mail recipients, which is not the case today.

## Verification
- `npm test`: the `po-unit` rule truth table (no units, chosen, default, no mapping, wrong manufacturer's unit, inactive unit).
- `npm run test:db`: the PDF query prefers `po.mfg_unit_id` over the mapping; the bulk check refuses a bad code; and split children inherit the unit.
- Dev, end to end:
  - raise one NG PO per unit from Add PO, then Review PDF;
  - upload a bulk file with blank / `MBA` / `MB2` / `XYZ` rows (`XYZ` is refused at upload), approve, then check the PDFs;
  - for a non-NG manufacturer, confirm there's no select and the PDF is unchanged.
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`.
