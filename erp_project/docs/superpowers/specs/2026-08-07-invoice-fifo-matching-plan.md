# Invoice Inwarding — SKU/Mfg validation, FIFO PO matching, BOM column, single Uniware PO

**Status:** implemented 2026-08-07. Behaviour is documented in `docs/po-inwarding.md`;
this file is kept for the reasoning behind the choices, not as a description of the code.
**Touches:** `app/po-tracking/po-inwarding/*`, `lib/queries/purchase-orders.ts`, `lib/validation/purchase-orders.ts`, `lib/invoice-inward.ts`, `lib/uniware.ts`, `types/invoice.ts`.

---

## What already exists (so we don't rebuild it)

| Requirement | Current state |
|---|---|
| SKU fuzzy match | `matchSku` in `lib/invoice-mapping.ts`, run by `rowsFromParsed`. No match ⇒ `sku_code: ""` |
| Mfg fuzzy match | `matchMfg`, run by `formFromParsed`. No match ⇒ `mfgId: ""` |
| Open POs per mfg | `GET /api/v1/purchase-orders/open-for-receive?mfg_id=` → `openForReceiveByMfg` |
| Over-receipt guard | `lib/po-receive.ts` already throws `400 over_limit`. **Server-side availability is already safe** — the client work below is UX, not a trust boundary |
| One Uniware PO for all lines | **Already done.** `lib/invoice-inward.ts:305` sends one `createPurchaseOrder` with `written.poLines.map(...)`. Only the reference-order field is missing |
| `purchase_orders.recipe_id` | Column exists, **never written by any INSERT**. Dead at the time of this plan — *fixed afterwards*: every creation path now stamps it, see the `recipe_id` section in `docs/po-inwarding.md` |

---

## The one structural decision

An invoice line for 500 units may need **two or three** open POs to be fulfilled. But
`invoice_items_mfg` / the payload carry **one `reference_po_id` per line**.

**Decision: FIFO splits the invoice row into one row per PO consumed.** No schema change,
no change to `writeInvoiceAndPos`, no change to `receivePo`. Each allocation becomes an
ordinary line item that already works end to end. The alternative — a nested
`allocations[]` array — would touch the payload, the schema, the write path and the
history tables for no gain.

Each `Row` gains a `line_key` (stable id of the *original* invoice line) so a re-match
can merge the splits back before re-allocating.

---

## Changes, in order

### 1. `lib/queries/purchase-orders.ts` — `openForReceiveByMfg`

```sql
SELECT po.id, po.po_no, po.date, po.sku_code, sk.name AS sku_name,
       mb.bom_code,                                   -- NEW
       po.qty, COALESCE(po.received_qty,0) AS received_qty,
       (po.qty - COALESCE(po.received_qty,0)) AS remaining,
       po.expected_on, <EFFECTIVE_STATUS_EXPR> AS status
FROM purchase_orders po
LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
LEFT JOIN master_recipe  mb ON mb.id = sk.active_bom_id  -- NEW
WHERE po.mfg_id = ? AND <EFFECTIVE_STATUS_EXPR> IN ('raised','partially_received')
ORDER BY po.date ASC, po.id ASC                       -- was DESC — FIFO, req #5
```

`types/invoice.ts` → `OpenPoOption` gains `date: string | null` and `bom_code: string | null`.

No migration. No new endpoint.

### 2. `invoice-form.ts` — the FIFO allocator (pure, testable)

```ts
export function allocateFifo(rows: Row[], openPos: OpenPoOption[]):
  { rows: Row[]; shortages: { sku_code: string; needed: number; available: number }[] }
```

- Merge current rows back by `line_key` (sum qty) so re-running is idempotent.
- Bucket open POs by normalised `sku_code`; each bucket sorted by `date` ASC, `id` ASC — **PO raise date**, req #5.
- Track `remaining` per PO id across the *whole* invoice, so two lines of the same SKU can't both claim the same PO.
- Per line: consume buckets until qty is covered; each chunk → a cloned `Row` with `reference_po_id` set and `qty` = chunk.
- Uncovered remainder → a row with `reference_po_id: ""` **plus** a `shortages` entry. That single leftover row trips the "reference PO required" rule below, so req #3 (block submit) and "no blank reference PO" are one mechanism, not two.
- `amount` / `total_amount` are **pro-rated by qty share**, 2dp, last chunk takes the rounding remainder so `sumLineItems` still equals the invoice. `rate` / `mrp` / `discount` / `gst_percent` copy unchanged.

**When it runs:** automatically in the effect that receives `openPos` (same moment
`changeMfg` already invalidates references), and from an explicit **"Re-match POs (FIFO)"**
button in the line-items header. Not on every keystroke — that would shred rows mid-typing.
A qty edit that breaks an allocation is already caught by the outstanding-qty check, which
tells the user to re-match.

### 3. `invoice-form.ts` — `collectProblems`, four new/changed rules

| # | Rule | Message |
|---|---|---|
| 1 | Row has a `parsed_code` but no `sku_code` | `Row 3: "Mcaf407" doesn't match any SKU in the system.` |
| 2 | `form.parsedFrom` set but `mfgId` empty | `"REVE PHARMA" doesn't match any manufacturer in the system.` |
| 3 | Any row with `reference_po_id === ""` | `Row 3 has no reference PO.` (req: never blank) |
| 3b | Shortage from the allocator | `Only 300 of 500 units of MCAF-407 are on open POs — 200 short.` |
| — | **Fix:** the existing per-row `qty > po.remaining` check | becomes an **aggregate per PO id** — after a split two rows can legitimately share one PO, and per-row comparison would pass while the sum overdraws it |

Submit button already disables on `problems.length > 0`, so req #3 needs no button change.

### 4. `InvoiceLineItems.tsx`

- New read-only **BOM Code** column (req #4), after SKU: `poById.get(r.reference_po_id)?.bom_code ?? "—"`.
- Reference PO cell gets the amber warn class when empty; the "clear — create a new PO instead" link is **removed** (blank is no longer legal).
- Header gets the **Re-match POs (FIFO)** button.
- `colSpan` on `TableEmpty` 15 → 16; needs `poById` passed in (or built locally).

### 5. `lib/validation/purchase-orders.ts`

`reference_po_id` becomes **required** on every line item; the `superRefine` "SKU or reference PO" rule is replaced by "reference PO required, SKU required".

> ⚠️ **Capability loss, accepted deliberately:** this removes the "raise a plain inward PO
> with no pre-existing order" path from the API entirely. The dialog is the only caller, so
> nothing else breaks — but an invoice for goods nobody ordered can no longer be inwarded.
> Confirmed: enforce in **both** API and UI.

### 6. `lib/uniware.ts` + `lib/invoice-inward.ts` — reference orders

Uniware is **already** one PO for all lines. Only the reference field is new:

Field name is **`ReferenceOrder`** (confirmed). Sent as a **custom field**, not a body key —
`buildPurchaseOrder` documents that Uniware rejects unknown body keys, and `customFieldValues`
is the extension mechanism already carrying `invoiceNo` / `invoiceDate`:

```ts
customFields: {
  invoiceNo: invoice_no,
  invoiceDate: written.expectedOn,
  ReferenceOrder: refPoNos.join(","),   // NEW
}
```

`refPoNos` = `written.received.map(r => r.po_no)`, **deduped, in line order** — the
pre-existing POs the inwarding happened against (confirmed), not the new `-INW-` numbers.
Omitted entirely when empty, so the field never goes up blank.

> If Uniware rejects `ReferenceOrder` as an unconfigured custom field, the fix is one line —
> move it into the body payload in `buildPurchaseOrder`.

### 7. Test

One `tests/unit/invoice-fifo.test.ts` (`node:test`, per CLAUDE.md — no vitest):
exact fit, split across two POs, shortage, two lines competing for one PO, pro-rated amounts
summing back to the line total.

---

## Resolved

| Question | Answer |
|---|---|
| Uniware reference-order field name | `ReferenceOrder` |
| Which PO numbers | The existing POs received against |
| Blank reference PO | Rejected by **both** API and UI |

Nothing blocking. Ready to build all seven items.
