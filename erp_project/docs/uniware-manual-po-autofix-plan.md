# Uniware-only POs: fix them, not list them

Today Find Uniware-only POs only reports. This plan makes it fix each case itself, one confirm for the whole batch.

## What "fix" does per case (prod, 2026-11-03)

| Case | Count | Fix | What it writes |
|---|---|---|---|
| Missing: Uniware PO, no ERP invoice | most of the other 197 manufacturer rows | Create the ERP invoice from the Uniware PO and link it. Same allocation as Add Invoice: credits `received_qty` on open FG POs, FIFO. | `invoice_mfg` + lines + inward POs + `history_pos`. No Uniware call, no mail. |
| Replacement, same SKUs and qty (group A) | 7 | Relink: point the ERP invoice at the hand-made PO. Quantities are already right. | `invoice_mfg.uniware_po_code`, its inward POs' code, an audit row. |
| Replacement, different SKUs (group B) | 2 | Revert and re-add against the hand-made PO. | Revert writes + a new invoice as in "Missing". |
| Duplicate | 1 | Cancel the stray PO in Uniware. | A Uniware write. |
| Not FG | the rest | Nothing. | — |

## What an auto-made invoice lacks

The Uniware PO carries invoice number, SKU, qty, unit price, MRP, facility, created date. It does **not** carry:
- **The PDF.** Add Invoice requires one today. Auto invoices are tagged "Entered in Uniware, no document" and can have the PDF attached later.
- **Invoice date.** The Uniware PO's created date is used.
- **GST, freight, batch, HSN.** Left empty; amounts are qty × Uniware unit price, pre-GST.

So three-way match and payment will show these as incomplete until a document is attached.

## Decided 2026-11-03

- **Missing:** the button creates the invoice itself, tagged "Entered in Uniware, no document".
- **Qty:** GRN accepted qty, falling back to the PO qty when there is no GRN. The GRNs are read with the existing GRN sync helpers, then mirrored to `grn_uniware` against the new invoice.
- **Replacements:** relink the 7 same-SKU ones directly. For the 2 with different SKUs, stage a revert approval; the re-add runs on approve.
- **Duplicate:** cancelled by hand in Uniware. The button keeps telling you which one.

## Gates

1. ✅ **Your decisions** (above).
2. ✅ **Built on dev (2026-11-03).**
   - DB tests cover the create (accepted qty, no document, link, second run refused) and the relink (codes move, history row, received qty unchanged, stale code refused).
   - The dev dry run skips every row. Dev has no open FG POs to match, and two facilities (Mcaff_Chennai, HYP_SPCHN) have no GSTIN.
   - Nothing is written to Uniware.
3. ⛔ **Your click-through on dev**, then prod deploy.
4. ⛔ **First prod run with your go-ahead**: a dry run listing exactly what it would write, then the real run.

## Risks

- **Wrong received qty.** If a hand-made PO's qty is not what arrived, FG POs are credited wrongly. Mitigation: use the GRN's accepted qty when Uniware has a GRN, PO qty otherwise.
- **Revert bypasses approval (group B).** The revert flow needs an approver and refuses self-approval. Automating it removes that check. Recommendation: stage the revert approval automatically; the re-add runs when it is approved.
- **Uniware cancel is a new API write** (duplicate). There is no cancel helper in the ERP today. Recommendation: leave the one duplicate to be cancelled by hand.
- **Not undoable in one click.** Each auto invoice is revertable through the normal revert flow, one at a time.
