# Discard a Draft PO

## What and why
A **Draft** PO — raised and approved, but never mailed (`isDraftPo`, `lib/po/po-rules.ts`) — is an order the manufacturer has never seen. Today the only way to get rid of one is **Cancel PO**, which treats it like a withdrawn order: it sits in the Cancelled tab beside the 48 POs cancelled after the manufacturer had them, and nothing marks it as never-sent. Discard is the draft-only exit: "this was never ordered".

## Prod today (read-only, 2026-10-27)
| | |
|---|---|
| Drafts (raised, not mailed, not inward) | **11** |
| …with goods already booked against them | **1** — an invoice inwarded against a draft; it must not be discardable |
| Already cancelled without ever being mailed | 3 (Jun–Aug) — these are discards in all but name |
| Cancelled after mailing | 48 |
| Stored `draft` / `rejected` | 0 |

Procurement POs are never pushed to Uniware (a Uniware PO is created only at invoice inward), so a discard has nothing to undo there.

## Decided (2026-10-27)
New `discarded` ENUM value (`prisma/add_po_discarded_status.sql`, applied to dev and prod) · direct, editor, reason required · listed under the Cancelled tab with a Discarded badge. MCAFF-PO-202610-025 was discarded on prod by script the same day, ahead of the code.

## Options considered
1. **How it's stored.**
   - **Recommended: `cancelled` + never mailed.** A discard writes `status = 'cancelled'` on a PO with no `email_sent_at`; "discarded" is *derived* from that pair, the way Draft is derived today. No DDL. Every place that already treats `cancelled` as dead — the special-PO slot, split-child totals, open qty, the ongoing-PO mail table, FIFO receiving — keeps working untouched. The 3 historic never-mailed cancels read as Discarded too, which is accurate.
   - Alternative: a new `discarded` ENUM value. Cleaner name, but DDL on both schemas plus an audit of ~10 status lists that exclude `cancelled` by name; miss one and a discarded PO counts as live.
2. **Approval or direct.** Recommended **direct**, for editors, with a mandatory reason — Cancel is direct today and nothing has left the building. (Draft *edits* go through `PO_EDIT` because they change what will be sent; a discard sends nothing.)
3. **Where a discarded PO shows.** Recommended: in the existing **Cancelled** tab with a **Discarded** badge (improves the tab in place, keeps it auditable). Alternative: hidden from PO Tracking entirely, like unapproved POs.

## Rules (server-side; the menu hiding the button is never the guard)
Discard is allowed only when, on the **locked** row:
- the PO is a Draft: stored `raised` and `email_sent_at IS NULL`;
- it is not inward and not a split child, and has no live split children;
- `received_qty = 0` **and** no invoice line is booked against it (`invoice_items_mfg.received_against_po_id`);
- no `PO_EDIT` approval is pending (reject that first — otherwise approving it later would edit a discarded PO).

And afterwards:
- **send-mail refuses it** (409 `po_discarded`) — a cancelled, never-mailed PO must never produce a cancellation mail for an order the manufacturer never had;
- a special PO's one-per-(SKU, mfg, type) slot frees itself (already excludes `cancelled`);
- any pre-rendered PO document in S3 is left in place, not deleted.

## Sequencing and gates
1. **Decisions 1–3** — you. ⛔
2. **Code on dev** — me:
   - `lib/po/po-discard.ts`: `canDiscardPo` (pure) + `discardDraftPo(conn, id, reason, userId)` taking an open connection — locks, re-checks every rule above, writes the status and a `history_pos` row (`status: raised → cancelled`, plus the reason), matching `lib/po/po-edit.ts`;
   - `POST /api/v1/purchase-orders/[id]/discard` — `assertPoInScope`, `withGateway`, reason required;
   - `send-mail`: refuse discarded POs;
   - PO Tracking: **Discard Draft** replaces **Cancel PO** in a Draft row's menu (reason dialog modelled on `CancelPODialog`); **Discarded** badge in the Cancelled tab.
   - Tests: unit for `canDiscardPo`; DB test — discards a clean draft, refuses each blocked case (mailed, received, invoice-booked, pending edit, split child), frees a special-PO slot.
   - `tsc --incremental false`, `npm test`, `npm run test:db`, `lint:changed`, `build`; dev click-through. ⛔ your sign-off.
3. **Prod** — deploy only; no migration with decision 1 as recommended. ⛔

## Risks
- **A draft mailed between opening the dialog and confirming** — the route re-checks `email_sent_at` on the locked row, so a race ends in a refusal, not a silently "discarded" sent PO.
- **Reports that count cancellations** (e.g. the daily ops digest) will now include discards unless they also check `email_sent_at`. Audited in step 2; any that should exclude discards get the same derived rule.
- **The one draft with goods booked against it** stays non-discardable by design — it needs Short Close or the invoice revert flow, not a discard.
