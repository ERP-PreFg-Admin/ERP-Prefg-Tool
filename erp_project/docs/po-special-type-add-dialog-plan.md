# Add PO — choose CPR / NPD / Tech Transfer per PO — plan

**Status:** built on dev 2026-10-14 (Ajay: "Start", with D1, D3 and D4 as recommended), uncommitted.
- **Tests:** 8 unit and 4 DB tests added.
- **Checks:** `tsc --incremental false` is clean, and lint adds nothing new.
- **Not yet:** a build (dev server running) and Ajay's click-through on dev.

## What exists today

CPR, NPD and Tech Transfer are already PO types (`purchase_orders.po_type`, added
2026-10-06, `docs/po-bulk-type-plan.md`). They carry these rules:
- **Price 0:** they are raised at ₹0.
- **Once per pair:** one live PO per (SKU, manufacturer, type).
- **Remarks required.**
- **PDF:** the PDF prints "This is a CPR/NPD/Tech Transfer order…".
- **List:** they show as a badge (CPR / NPD / TT) and can be filtered in the PO list.

**But only the bulk CSV can raise them.** Add PO lets you choose only normal or
impromptu, and impromptu applies to every row in the dialog.

## The change

**Add PO gets a per-row choice.** Each SKU row, and so each PO (one row = one PO),
gets a small checklist: ☐ CPR ☐ NPD ☐ Tech Transfer. Leaving all three unticked
means a normal (or impromptu) PO, as today.

**No DDL.** The types and their ENUM values already exist on dev and prod.

| Piece | What changes |
|---|---|
| `AddPODialog.tsx` | A 3-option checklist on each row. Ticking a type shows "₹0", hides the quoted rate, and makes the Reason field required |
| `poCreateSchema` | `po_type` also accepts `npd`, `tech_transfer`, `cpr` |
| `POST /purchase-orders` | Special type → price forced to 0 (`specialPoPrice`), the once-per-pair check (`selectLiveSpecialPo`, 409 naming the existing PO), then raised as decided in D2 |
| Approval card | Shows the type when a special PO goes to approval |

Everything downstream is already built and needs no change:
- the badge, filter and export;
- the PDF wording and the ₹0 amounts;
- splits (children inherit the type);
- the invoice three-way "No agreed rate (CPR)".

## Sequence and gates

1. **Schema + route** (pure rule tests + a DB test for the once-per-pair 409).
   - **Gate:** `npm test`, `npm run test:db`, `tsc --incremental false`, `lint:changed`.
2. **Dialog.**
   - **Gate:** on dev, raise one PO of each type plus a normal one in the same dialog.
   - Check that each is priced correctly, that the badge shows, and that a second
     CPR for the same SKU and manufacturer is refused.
3. **Build + deploy.** No migration.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | One type per PO, or several at once (e.g. CPR **and** NPD)? | **One**: the boxes act like a radio. `po_type` holds one value, and price-0, once-per-pair and the PDF wording are all per type. Several at once needs a new column and redefining those rules |
| D2 | Does a CPR/NPD/TT PO from Add PO need approval? | **Decided (Ajay, 2026-10-14): yes.** Inserted as `draft` with a `PO` approval, like impromptu; it becomes `raised` only on approve. The approval card shows the type and "₹0 (CPR)" so the approver sees what they are signing off. Reject leaves it rejected, re-editable by the submitter. The once-per-pair check runs at submit **and** again on approve |
| D3 | Impromptu toggle ticked + a row marked CPR | The row's special type wins; the other rows stay impromptu |
| D4 | Can a draft's type be changed later (Edit Draft PO)? | **No**, as in the bulk upload. Cancel and raise again |

## Risks

| Risk | Mitigation |
|---|---|
| A ₹0 PO raised by mistake | Approval (D2), the badge on the row, and Reason required |
| Two people raise the same CPR at once | The once-per-pair check runs again inside the insert transaction, as the bulk approval does |
| The client sends a price | The server ignores it and forces 0, the same as it already re-prices normal POs |
