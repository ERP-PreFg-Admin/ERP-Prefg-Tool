# MFG line status: auto `effective_to` + approval-gated activation

## Context

In MFG Cost Manager, a manufacturer's recipe lines (`master_recipe_mfg`, edited
via `POST /api/v1/manufacturing/lines`) carry a `status`
(active / discontinued / inactive) and an `effective_to`. Today these are edited
by **direct write, no approval** (the route says so), and `status` and
`effective_to` are **independent** — changing status never touches
`effective_to`. Two problems follow:

1. Deactivating a line leaves `effective_to` untouched, so a line's active period
   never actually closes on status change.
2. Anyone with editor access can flip a line back to **active** directly — no
   review — which is what actually re-enables costing and PO-raising for it.

## Decisions (confirmed 2026-09-07)

- **`effective_to` is derived from status**, server-side:
  - → `active`  ⇒ `effective_to = NULL` (open-ended)
  - → `inactive` **or** `discontinued` ⇒ `effective_to = today (IST)`
  - *Accepted trade-off:* setting `effective_to` on `discontinued` drops it from
    costing (costing filters `effective_to IS NULL OR effective_to >= today`).
    This changes the prior "discontinued still counts as live" behaviour — chosen
    deliberately.
- **Only activation needs approval.** `inactive/discontinued → active` goes
  through `/approvals`; deactivation and non-status edits stay direct writes.

## The governing rule

**An activation request must NOT change the line until approved.** The line
stays `inactive`/`discontinued` — and therefore keeps *not* costing — while the
request sits in the queue. This is deliberately different from the standard
approval pattern (which locks the entity to `in_review`): locking is unnecessary
here because the un-activated line is already in a safe, non-costing state, and
it avoids adding an `in_review` value to the status ENUM.

---

## Part A — `effective_to` auto-managed (direct path)

Server is authoritative; the client no longer decides `effective_to`.

- `app/api/v1/manufacturing/lines/route.ts`, `update` (and `create`) — derive:
  ```
  active                    → effective_to = NULL
  just deactivated (was active) → effective_to = todayIST()
  already deactivated, edited   → keep the stored effective_to (don't move it)
  ```
  Fetch current `status` + `effective_to` (extend `selectLineById`) to tell
  "just deactivated" from "already deactivated". `create` with a non-active
  status stamps today.
- `lib/queries/manufacturing.ts` — `selectLineById` returns `status`,
  `effective_to`; `updateLine` stays as is (route passes the derived value).
- `app/manufacturing/[mfgId]/LineDialog.tsx` — on **update**, `effective_to`
  becomes read-only/auto (a note: "set automatically when a line is
  deactivated"); the manual date input is removed from the update path so the UI
  matches the server rule. `effective_from` stays create-only as today.

## Part B — activation through approval (new module `MFG_LINE`)

Follows the `MFG_MISC` analog — the existing manufacturing sub-entity in the
approval flow.

1. **Route** (`lines/route.ts`, `update`): detect
   `stored.status ∈ {inactive,discontinued} && body.status === 'active'`.
   - If so → **stage, don't write**: `approvalsSql.hasPending('MFG_LINE', id)`
     (409 if pending) → `insertApproval(userId,'MFG_LINE',id)` +
     `insertApprovalItem(field:'status', old:stored.status, new:'active')`.
     Return `{ ok:true, approval_id }`. The line is untouched.
   - Else → the Part A direct path.
2. **Handler** `lib/approvals/handlers/mfg-line.ts` + register `MFG_LINE` in
   `MODULE_HANDLERS`:
   - `applyAndArchive` → set line `status='active'`, `effective_to=NULL`
     (new query `setLineActive`), optional `history_*` snapshot.
   - `setStatus` (reject) → **no-op**: nothing was changed on submit, so a
     rejected request just leaves the line deactivated.
3. **Approvals UI wiring** (mirror `MFG_MISC`): `MODULE_LABEL['MFG_LINE']`,
   `MODULE_COLOR`, `entityLabelSql` (line id → `sku_code` + mfg) in
   `lib/queries/approvals.ts`; add `MFG_LINE` to `app/approvals/approvals-types.ts`
   and a diff renderer in `app/approvals/approval-card/` (status old→new is a
   simple field diff — reuse the generic renderer if one fits).
4. **Client** `LineDialog.tsx`: when the change is an activation, the Save button
   reads "Send for approval", and a `200 { approval_id }` shows a "sent for
   approval" toast rather than "saved".

No ENUM change, no migration (the line is never set to `in_review`).

---

## Sequencing

| # | Step | Gate |
|---|---|---|
| 1 | Part A: server-derived `effective_to` + `selectLineById` fields | deactivate a line → `effective_to` = today; reactivate path still direct for now |
| 2 | Part B route: stage activation as `MFG_LINE` approval | activating stages a row, line stays inactive |
| 3 | Part B handler + approvals UI wiring | approve → line goes active, `effective_to` NULL; reject → stays inactive |
| 4 | `LineDialog` UX (read-only `effective_to`, "Send for approval") | — |

## Risks

| Risk | Mitigation |
|---|---|
| Activation silently writes anyway (misdetected transition) | Detect on **stored** status from the DB, not the client's claim; unit-cover the transition matrix |
| Discontinued lines vanish from costing unexpectedly | Called out above — it's the chosen behaviour; flag in the commit/PR so procurement knows |
| `effective_to` moved on every unrelated edit | "already deactivated → keep stored" branch; only stamp today on the active→inactive/discontinued transition |
| Duplicate activation requests | `hasPending('MFG_LINE', id)` 409, same as every other module |
| Reject leaves a stale lock | There is no lock — reject is a no-op by design |

## Verification

- `npx tsc --noEmit --incremental false`, `npm run lint:changed`, `npm test`
  (add a unit test for the status→`effective_to` derivation and the
  activation-transition detection — both pure, extractable).
- Deactivate a live line → `effective_to` = today; it drops out of costing.
- Activate a deactivated line → an `MFG_LINE` row appears in `/approvals`, the
  line stays inactive; approve → active + `effective_to` NULL; reject → unchanged.
- A second activation while one is pending → 409.
- Non-status edit on an active line → still a direct write, `effective_to` NULL.
