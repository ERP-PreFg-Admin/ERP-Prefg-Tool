# Warehouse form: make it clear which ship-to address is used

## Context
On 2026-10-30 and 2026-11-03 (approvals #1628, #1635), Lucknow's new Khatola address went into **"Ship To Address (as printed)"** only. The structured fields (Building/Plot, Area, City, State, PIN) still said Amausi / 226008. Everything that uses an address reads the structured fields first and falls back to "as printed" only when they're empty:
- the PO document (`resolveShipTo`, `lib/pdf/po-letterhead.ts:223`);
- the warehouse detail panel (`WarehouseDetailPanel.tsx:151`);
- invoice matching (`masterPin`, `lib/invoice/invoice-mapping.ts`).

So the edit was approved and saved, yet changed nothing anyone sees. It was fixed by hand on 2026-11-03 (rows 44/45, history version 3).

The form (`app/masters/warehouses/EntitySection.tsx`) shows both blocks with equal weight and no hint, and the approval card shows a lone "Ship To Address" change with nothing pointing out that the address used didn't move.

**Goal:** the person editing, and the approver, can see that the structured fields are the address that gets used. Improve the existing form and card in place: no new sections, no schema change.

## Changes

### 1. Say which block is used (form)
`EntitySection.tsx`, under "Ship To Address (as printed)": a one-line help text, *"Only used when the fields above are blank. POs and invoice matching use Building / Plot, Area, City and PIN."* The structured group's PIN field gets a short hint, *"Printed on POs"*.

### 2. Warn when the two disagree (form)
- Take the PIN inside "as printed" with `extractPincode` (`lib/invoice/invoice-mapping.ts`, pure, already used client-side by the inwarding form).
- If both PINs exist and differ, show an amber line under "as printed": *"This address has PIN 226301 but the Pincode field says 226008 — POs will print the 226008 address. Update the fields above too."*
- The same warning appears when "as printed" was edited in this session but no structured field was, compared against the values the dialog opened with (`EditWarehouseDialog.tsx`).
- **It's a warning, not a block.** A different printed format, or a site whose paperwork address deliberately differs, must still save. The comparison is a small pure helper, `shipToMismatch(form, initial)`, in `app/masters/warehouses/`, so it's unit-testable.

### 3. Tell the approver (approval card)
- For a `WAREHOUSE` approval, `FieldDiffTable` / `ApprovalCard` look at the item names.
- If `ship_to_address:<ENTITY>` changed and **none** of `ship_to_line1 / ship_to_line2 / ship_to_city / ship_to_state / ship_to_pincode:<ENTITY>` did, show one amber line above the diff: *"Only the printed ship-to address changed for <ENTITY>. The structured address — what POs print — is unchanged."*
- This needs nothing beyond the approval's own items. It works on pending approvals already in the queue, and stays quiet when the structured fields changed too.

## Files
- `app/masters/warehouses/EntitySection.tsx`: help text and warning.
- `app/masters/warehouses/EditWarehouseDialog.tsx`: passes the opening values down.
- New pure helper: `app/masters/warehouses/address-check.ts` (`shipToMismatch`, `printedOnlyChange`).
- `app/approvals/approval-card/ApprovalCard.tsx`: the note for `WAREHOUSE`.
- Test: `tests/unit/warehouse-address-check.test.ts`.

## Gates and risk
- UI only. No API, query, approval-handler or schema change, and nothing blocks a save.
- **Risk:** false warnings when "as printed" has no PIN, or two six-digit numbers. `extractPincode` already takes the last PIN-shaped number, and a missing PIN gives no warning.
- Bill To has no structured fields, so it's out of scope. The Pep bill-to on Lucknow was kept as is, by decision.

## Verification
- **Unit tests:** PIN mismatch → warning; same PIN → none; no PIN in the text → none; printed-only change → approver note; printed + PIN changed → no note.
- **Manual (`npm run dev`):**
  - Edit a warehouse, change only "as printed" to a different PIN: the amber warning shows and the save still goes through.
  - The approval card shows the note.
  - Change the PIN field too: both warnings go away.
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`.
