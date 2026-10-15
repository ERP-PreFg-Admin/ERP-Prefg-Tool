# Edit a Draft PO from FG PO Tracking — plan

**Status:** built 2026-10-08 (uncommitted). D2 superseded by the revision below — every edit goes
through `PO_EDIT` approval. R1: block mailing while pending, shown as Draft + In Review. R2: edits only.
Not yet exercised in the browser. Prod gate: `add_po_gst_columns.sql` first.

## Revision 2026-10-08 — every PO update goes through approval (supersedes D2)

Ajay: "PO updation should always go through the approval flow." The in-place edit built
earlier saves immediately; it must instead stage, and apply only on approve.

| Step | What happens |
|---|---|
| Submit | Edit dialog → `PUT` validates + diffs, **writes nothing to the PO**. Inserts one approval, new module **`PO_EDIT`** (`approval_type='edit'`), one `approval_items` row per changed field (old → new) + `reason`. 409 if a PO approval is already pending. |
| While pending | PO is unchanged and still Draft. Row menu shows **Edit PO** disabled ("edit awaiting approval"); row gets a small "Edit pending" marker. |
| Approve | `PO_EDIT.applyAndArchive` → `applyDraftPoEdit` on the locked row (all of today's re-checks), history rows. History card shows submitter + approver. |
| Reject | PO untouched; remarks mandatory as everywhere. Submitter can edit again. |

New module code, not `PO`: `PO`'s handler means "approve an impromptu PO → raised", and 40+
existing rows key off it. No DDL (`approvals.module` is VARCHAR; PO status untouched).

**Open decisions**

| # | Question | Recommendation |
|---|---|---|
| R1 | Mail a PO while its edit is pending? | **Block** — the send refuses it ("edit awaiting approval"). Otherwise the approver approves an edit the manufacturer never sees, or the approval fails because the PO was mailed meanwhile. |
| R2 | Does "always" cover Cancel / Short Close (direct today)? | **Edits only** in this change. Cancel / Short Close are close-outs, not updates, and are mailed to the mfg as such. Say if you want them gated too — separate change. |

## The gap

FG PO Tracking already has an Edit action, but it is gated on the **stored** status
(`PoDataRow.tsx:77` — `raw_status === "draft"` and only the original raiser), and the
PUT route refuses anything else (`app/api/v1/purchase-orders/[id]/route.ts:68`).

"Draft" on screen means something wider — `isDraftPo()`: stored `draft`, **or** stored
`raised` with no `email_sent_at`. Prod today (read-only, 2026-10-08):

| Stored status | Type | Split child | Count | Pending approval |
|---|---|---|---|---|
| raised (unmailed) | normal | no | 6 | 0 |
| draft | — | — | 0 | — |

So the Edit button currently shows on **none** of the 6 rows badged Draft.

## Rule

A PO is editable **iff it reads as Draft** (`isDraftPo`) — the manufacturer hasn't
been told about it. Once mailed: cancel or short-close only. This is the same line the
in-progress bulk CSV update path already draws (`bulkUpdateBlock`), so the screen and
the CSV give one answer.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Which rows | Every Draft row **except** split children and inward POs. A child's qty is bounded by its parent's allocation; drafts can't be split, so no master has children. |
| D2 | Approval? | **Raised-unmailed: direct edit**, no approval — it reached `raised` either directly (normal) or already approved (impromptu), and nothing has left the building. **Stored `draft`: keep today's re-submit-for-approval path** unchanged. |
| D3 | Who may edit | Any **editor on `/po-tracking/po-procurement`** with the PO in scope — not only the raiser. The desk is shared. |
| D4 | Editable fields | **Qty, destination, expected date, remarks.** SKU and manufacturer stay **locked**: changing either changes the rate, the recipe, and the brand prefix baked into `po_no`. Wrong SKU/mfg → cancel and re-raise. |
| D5 | Price on a qty change | Keep the PO's **own `unit_price`**; recompute amount/total from the new qty (`poTotal`). Same as split children and "Updates PO — price unchanged" on the CSV path. Not re-quoted from today's costing. |
| D6 | Reason | **Mandatory edit reason**, like master edits; stored on every `history_pos` row the edit writes. |
| D7 | Who writes it | Frontend is mine. API + `lib/po/po-edit.ts`: you, or me? |

## Sequence and gates

1. **Shared rule** — `canEditDraftPo(po)` in `lib/po/po-rules.ts` (pure, unit-tested):
   `isDraftPo && po_type <> 'inward' && reference_po IS NULL`. UI and API both call it.
2. **Write helper** — `lib/po/po-edit.ts`, taking an open connection (the `po-receive.ts`
   pattern, so it is DB-testable under `withRollback`): `SELECT … FOR UPDATE`, re-check
   `canEditDraftPo` on the locked row, re-check destination serves the SKU's entity,
   update, one `history_pos` row per changed field with the reason.
3. **API** — extend `PUT /purchase-orders/[id]`: stored `draft` → existing approval flow;
   raised-unmailed → step 2 in its own transaction. 409 if mailed in the meantime.
   No new route; nothing removed.
4. **UI** — Edit in the row menu on every Draft row the rule allows. One dialog:
   SKU / manufacturer / rate read-only, qty · destination (same options as Add PO) ·
   expected date · remarks editable, live recomputed total, required reason.
   Existing stored-draft rows keep opening the re-submit dialog.
5. **Tests** — unit for the rule; DB test for the helper (edit, mailed-race 409, history rows).
   **Gate:** `npm test`, `npm run test:db`, `tsc --incremental false`, `lint:changed` green.
6. **Dev → test → prod.** **No DDL.** Gate before prod: edit one of the 6 live drafts on
   test, confirm the mail then carries the new qty/destination.

## Dependency

The total recompute uses `poTotal` / `amount_pre_gst` from the **PO-total-includes-GST**
work — committed in `6f209f0` (2026-10-08), but `add_po_gst_columns.sql` is dev-only.
This ships **with or after** that migration reaches prod, never before.

## Risks

| Risk | Mitigation |
|---|---|
| Mail goes out while the dialog is open | Row lock + re-check in the write; 409 "already sent — cancel or short-close instead" |
| UI and API disagree on what's editable | One predicate, `canEditDraftPo`, used by both and by the CSV path |
| Silent change to an order | `history_pos` row per field, reason mandatory, visible in PO History |
| Qty change after a verbal/WhatsApp commitment to the mfg | Out of system; the reason field is where that gets said |

## Out of scope

Editing mailed POs (cancel / short-close remain the only actions), editing split
children, changing SKU or manufacturer, re-quoting the rate.
