# PO total includes the SKU's GST — with a pre-GST amount kept alongside

## Context

Ajay, 2026-10-06: the PO total should include GST taken from `master_skus.gst`,
the rate stays as it is, and existing POs must not be left meaning something
different from new ones — fix them, and keep a pre-GST figure.

Today `total_amount = unit_price × qty` (before GST) and the PDF adds a **flat
18%** on top (`GST_RATE`, `lib/pdf/po-document.tsx:70`), whatever the SKU.

## Target shape of `purchase_orders`

| Column | Meaning | |
|---|---|---|
| `unit_price` | agreed rate, before GST | unchanged |
| **`amount_pre_gst`** `DECIMAL(14,4)` | `unit_price × qty` | new |
| `total_amount` | `amount_pre_gst × (1 + master_skus.gst / 100)` — the real PO value | **now always incl. GST** |

**No `gst_percent` column** (Ajay, 2026-10-06 — GST already lives on
`master_skus`). GST is read from `master_skus.gst` when the total is computed;
afterwards every display derives the rate from the PO's own two amounts
(`impliedGstPercent`), so a later edit of `master_skus.gst` never relabels a PO
already sent. A split child takes the parent's implied rate.
Inward POs (mirrors of a supplier invoice) are **out of scope** and keep their
invoice figures; `amount_pre_gst` stays NULL on them.

> Sections below that mention a stored `gst_percent` describe the first draft;
> the code follows the table above. The staged bulk CSV still carries a
> `gst_percent` column — it is a file the approver reads, not a DB column.

## Findings that gate this (prod, read-only, 2026-10-06)

### 1. `master_skus.gst` is not clean enough to snapshot yet

24 of 320 SKUs are not 18%, and several are inconsistent with their own siblings:

| Product | 5% / 0% | 18% |
|---|---|---|
| Coffee bathing soap | `MCaf165`, `MCaf165_WB` (5%) | `MCaf165_F` — same soap |
| Shampoo | `MCaf272_WB`, `Mcaf404` (5%) | `MCFMUBX0428F0250`, `MCFMUWB0404F0025` |
| Soap | `3MCaf394`, `3MCaf395` (5%) | — |
| Sunscreen | 6 at **0%** | 34 |
| Face wash | 2 at **0%** | 10 |
| Others at 0% | 9 more (body butter, body wash, toner, cleanser, mask, balm) | — |
| `MCaf44` Brew Scoop | 12% | — |

The **0% rows look like missing data**, not a real rate — the same products sit at
18% elsewhere. The 5% soap/shampoo rows may reflect the September 2025 rate cut on
those categories, but their siblings were not updated. **Which rate is correct is
a finance call**, not something code can infer. Snapshotting today would print
0% GST on 17 SKUs' POs.

### 2. Three POs already went out with the wrong GST

Mailed, with saved PDFs, on SKUs that are 5% in the master but printed at 18%:

| PO | SKU | GST printed | GST at 5% | Over by |
|---|---|---|---|---|
| `MCAFF-PO-202609-017` | `MCaf165` | ₹1,15,668 | ₹32,130 | ₹83,538 |
| `MCAFF-PO-202609-027` | `Mcaf404` | ₹1,65,786 | ₹46,052 | ₹1,19,734 |
| `MCAFF-PO-202609-069` | `3MCaf394` | ₹74,390 | ₹20,664 | ₹53,726 |

Nine older POs on the same SKUs are unpriced, so they printed `—` — no wrong figure.
Whether to reissue the three depends on finding 1 (if 5% is itself wrong, they
were right).

### 3. Two POs whose stored total ≠ rate × qty

| PO | rate × qty | stored total | |
|---|---|---|---|
| `MCAFF-PO-202609-046` | 1,14,427 | 1,14,410 | ₹17 — rate stored as 13.4620, total from 13.46. Rounding; harmless |
| `MCAFF-PO-202609-024` | 17,32,315 | **12,84,439** | total implies qty ≈ 27,953 or rate ≈ 34.07 vs stored 37,700 @ 45.95. Both from bulk file `po_bulk_1790604614878.csv`, 2026-09-28, no edit in `history_pos`. **Needs a human look** |

## Sequencing and gates

1. **Gate 0 — GST master clean-up (owner: Ajay / finance).** Fix the 0% rows and
   decide the soap/shampoo rate, through the normal SKU approval flow. The backfill
   and the go-live both snapshot whatever the master says, so this comes first.
2. **Migration on dev** — add the two columns, backfill, **stop**. Ajay checks a
   handful of POs by hand.
3. **Code** — one total function, every writer, PDFs read the stored columns.
   Tested on dev.
4. **Prod migration** — own go-ahead, **before** the deploy (the code writes the
   new columns).
5. Deploy.
6. **Separately:** reissue decision for the 3 POs in finding 2, and a look at
   `MCAFF-PO-202609-024`.

## 1. Migration — `prisma/add_po_gst_columns.sql`

```sql
ALTER TABLE purchase_orders
  ADD COLUMN gst_percent    DECIMAL(5,2)  NULL AFTER unit_price,
  ADD COLUMN amount_pre_gst DECIMAL(14,4) NULL AFTER gst_percent;

-- Backfill: today's total IS the pre-GST amount. Runs once — the
-- amount_pre_gst IS NULL guard makes a second run a no-op instead of adding
-- GST twice.
UPDATE purchase_orders po
LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
SET po.amount_pre_gst = po.total_amount,
    po.gst_percent    = COALESCE(sk.gst, 18),
    po.total_amount   = ROUND(po.total_amount * (1 + COALESCE(sk.gst, 18) / 100), 2)
WHERE COALESCE(po.po_type, '') <> 'inward'
  AND po.total_amount IS NOT NULL
  AND po.amount_pre_gst IS NULL;
```

Scope today: prod **138** priced POs (455 unpriced untouched, 408 inward
excluded); dev 5. `ADD COLUMN` is not re-runnable on MySQL 8; the `UPDATE` is
guarded. Keep `schema.prisma` in sync.

## 2. Code

- **`poTotal(unitPrice, qty, gstPercent)`** in `lib/po/po-rules.ts` — returns
  `{ amountPreGst, totalAmount }`; NULL rate → both NULL; NULL GST → 18 (guard;
  prod has none).
- **Writers** — all insert `gst_percent`, `amount_pre_gst`, `total_amount`:

  | Path | GST from |
  |---|---|
  | Add PO / impromptu (`app/api/v1/purchase-orders/route.ts`) | `master_skus.gst` |
  | Bulk upload — preview note, staged CSV (`gst_percent` column added), approval (`classifyRate` + `lib/po/po-bulk-pricing.ts`) | `master_skus.gst` at upload |
  | Split (`[id]/split/route.ts`) | **the parent's `gst_percent`** — a split is the same order divided |
  | Draft re-edit (`[id]/route.ts`) | `master_skus.gst`; total recomputed server-side instead of trusting the client's `total_amount` |

  Bulk preview note becomes `₹24.31 × 2,500 + 18% GST = ₹71,714.50`.
- **PDFs** (`po-document.tsx`, `split-po-document.tsx`) — `base = amount_pre_gst`,
  `gst = total_amount − amount_pre_gst`, label = `gst_percent`%. Fallback for a row
  with no snapshot: rate × qty at 18%, i.e. today's output. `selectForEmail` and
  `PoEmailRow` gain the two columns.
- **PO table / Excel export** — Amount stays `total_amount` (now incl. GST); add
  **"Amount (pre-GST)"** and **"GST %"** columns beside it.
- **Unchanged:** the invoice three-way match (compares rates, both before GST);
  MFG Overview open value (sums `total_amount` — now incl. GST everywhere after
  the backfill; split children still excluded).

## Risks

1. **The backfill runs exactly once.** Guarded by `amount_pre_gst IS NULL`; still,
   run it inside a transaction and compare the 138-row count before committing.
2. **Snapshot quality = master quality.** Without Gate 0, 17 SKUs get 0% GST.
3. **Saved PDFs** keep their flat 18% (decision: leave saved PDFs alone) — which is
   why the 3 POs in finding 2 need an explicit reissue decision.
4. **Pending bulk approvals** staged before the deploy have no `gst_percent`
   column → the approval resolves GST from the master at that moment.
5. Interacts with the bulk-pricing (uncommitted) and NPD plans through
   `classifyRate`; NPD and unpriced POs stay NULL throughout.

## Verification

- `npm test` — `poTotal` at 0 / 5 / 12 / 18 / NULL GST, rounding, NULL rate.
- `npm run test:db` — a PO per GST rate via Add PO, bulk and split (child takes the
  parent's `gst_percent`); draft re-edit ignores a forged `total_amount`; the
  backfill run twice changes nothing the second time.
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`.
- Dev: after the migration, spot-check POs — `total_amount = amount_pre_gst ×
  (1 + gst_percent/100)`; preview PDFs for an 18% and a 5% SKU show the right base,
  GST, label and total.
