# Manual Uniware POs: bring them into the ERP

## What the 13 actually are (prod, 1 Oct – 2 Nov)
Every Uniware PO carries the invoice number in its `ReferenceNo` custom field, so each manual PO can be tied to its invoice.

| Kind | Count | What happened | Examples |
|---|---|---|---|
| **Replacement** | 7 | The invoice IS in the ERP, but its ERP-made Uniware PO is **CANCELLED**. Yogesh re-raised it by hand with a fix. | KCPL/C2627/1218: SKU HYPMUBX042F010 → HYPMUBX024F010. MBA2627/GIS00514: MCaf402 → MCFMUWB0402F0080. CLAR/2627/1777: Mumbai → Bangalore. MBA2627/GIS00522: Mumbai → Hyderabad3 |
| **Missing** | 4 | The invoice was never entered in the ERP | RP/L/26-27/1401 (Reve), MBA2627/GIS460, MBA2627/GIS00085 and GIS00086 (both marked "EXCESS PO") |
| **Not FG** | 2 | Items are `PMRAW133/134`, which are in neither the SKU nor the PM master | MBA2627/GIS00500, GIS00501 (NG Electro) |

This bears out the rule: an invoice has exactly one live Uniware PO. In each replacement the ERP's copy is cancelled.

**The replacements mean the ERP is wrong today, not just incomplete.** Each one holds the wrong SKU or destination, and has credited `received_qty` against an FG PO on that wrong basis.

## Shape: one adopt path, reached two ways
**Adopt** = Add Invoice, with "this invoice is already in Uniware as X" selected:
- the commit links the invoice to X instead of creating a new Uniware PO;
- everything else is unchanged: reference-PO picker, receipts, GRN, status and document sync.

| Kind | Route |
|---|---|
| Missing | Add Invoice → pick the matching Uniware PO → commit. |
| Replacement | First revert the wrong ERP invoice through the existing **Invoice Revert** approval. That reverses its receipts and frees the invoice number. Then Add Invoice again with the corrected SKU or destination, and pick the manual Uniware PO. |
| Not FG | Out of scope. The ERP has no PO for unmastered packing material. They are listed so nobody chases them. |

**No new write path for replacements.** The revert flow already exists, needs approval, and refuses self-approval. The ERP never repoints a live invoice in place.

## Sequencing and gates
| # | Step | Owner | Gate |
|---|---|---|---|
| 0 | Ask Yogesh's team to bring a correction to the ERP (revert + re-add), not re-raise it in Uniware | You | none |
| 1 | DDL `add_uniware_external_po.sql` on **dev**: code (UNIQUE), facility, vendor, mfg, `reference_no`, `created_by`, status, lines JSON, `kind`, `adopted_invoice_id` | me | ⛔ stop; prod needs your go-ahead |
| 2 | Sweep: "Find Uniware-only POs" button on the PO Inwarding toolbar. Each row is tagged replacement (its `reference_no` matches a live ERP invoice whose Uniware PO is cancelled), missing, or not-FG. | me | ⛔ your check on dev against prod data: 7 / 4 / 2 |
| 3 | Adopt in Add Invoice: a "Already in Uniware?" picker under Manufacturer, prefilled when a candidate's `reference_no` equals the invoice number. The commit links instead of creating. | me | ⛔ click-test on dev |
| 4 | Prod: DDL, deploy, run the sweep, then work the 7 + 4 by hand | you + me | ⛔ go-ahead each |

## Design notes
- **Sweep:**
  - `getPurchaseOrders(createdBetween)` per facility, then `getPurchaseOrderDetails`, both read-only and already used in `lib/uniware/po-explorer.ts`.
  - Codes already on an `invoice_mfg` are skipped, and every code seen is cached, so a re-run details only new ones.
  - It runs one facility per request, looped by the button. A full first pass is about 1,000 detail calls.
- **Vendor → manufacturer:** `un_code_mfg_sku_wh_map.un_mfg_code` at that facility, falling back to `master_mfgs.code`. A vendor that matches neither is cached as non-manufacturer and not listed. About 1,000 manual POs a month go to stock-transfer and other vendors, so an "unmatched" list would be noise. `N_G_Electro_Products` at mCaff_Kolkata2 is the one known gap: map it on MFG Overview, and the next sweep re-resolves cached rows without re-detailing them.
- **Server-side guards on adopt:** the PO must be
  - in the table and not yet adopted;
  - not cancelled, re-checked live at commit;
  - for the same manufacturer and the resolved facility, with every invoice SKU present on it.

  Adoption is marked in the same transaction as the invoice, guarded by `adopted_invoice_id IS NULL`, so two people can't adopt one PO.
- **Mail on adopt:** skipped. The warehouse raised the PO itself, so the inward notice would be news to nobody.
- **"EXCESS PO"** (GIS00085/86): the reference PO is mandatory, so these need an open FG PO with room. If none exists, the existing FIFO shortage message shows and someone raises one. FIFO itself is not changed.

## Open question
**Should the sweep also cover POs created before 1 Oct?** The plan uses a rolling 45 days.
