# Master history: "Uploaded by" + "Approved by", one way everywhere

## Goal
Every History view under Masters shows two stamps per entry, in the same shape and format:

- **Uploaded by** — name · date and time (IST)
- **Approved by** — name · date and time (IST), or *Pending* / *Rejected by …*

## Where things stand

| View | Opened from | Uploaded by | Approved by | Gap |
|---|---|---|---|---|
| `EntityHistoryDialog` → `HistoryTable` | SKU, Vendor, Mfg, Material Master (RM/PM), Recipe Master | ✅ name + date-time ("Submitted By") | ✅ name + date-time ("Approval" column) | Labels only. Pending shows just a pill |
| `RateHistoryDialog` | RM/PM Cost Master, × Mfg and × Vendor (4 pages) | ⚠️ "By X on …": X is the submitter, but the time is when it was **archived**, which is the approval time | ❌ approver never stored | Needs data |
| Recipe Archive (`RecipeHistoryTable`) | `/masters/recipe-master/history` | ✅ Created (who + when) | ✅ Approved (who + when) | Own formatter and cell. Restyle only |

There are four separate date-time formatters in these views, and `RateHistoryDialog`'s doesn't pin IST.

## Sequencing

**Step 1: shared stamp (frontend, no risk).**
One `AuditStamp` component (`label`, `name`, `at`) and one IST formatter in `lib/date.ts`. `HistoryTable` and `RecipeHistoryTable` switch to it. Columns get renamed to **Uploaded By** / **Approved By**, and a pending entry reads "Pending approval" in place of the bare pill. Ships on its own.

**Step 2: rate history data. ⛔ Gate: your call on A or B.**

- **A: add columns (recommended).** `history_cost_mfg` and `history_cost_ven` get `approved_by INT NULL` and `submitted_on DATETIME NULL`. The four rate handlers write `approverId` and the approval's `raised_on`, which means `applyAndArchive` takes one more optional arg, the same way `raisedBy` was added. The rate-period view (₹ · from → to) stays. Rows archived before this show "—" for whatever wasn't recorded.
  - Caveat to accept: an archive row is the **superseded** rate, but its stamps belong to the change that replaced it. So the card reads "Replaced by a change uploaded by X … approved by Y …". That's accurate, but not "who uploaded this rate".
- **B: no DDL.** Rate pages open `EntityHistoryDialog` with `RM_RATE` / `PM_RATE` / `RM_VRM` / `PM_VRM`, which reads `approvals` and already has both stamps. You lose the from → to period cards, and rates that arrived through a bulk CSV won't show their creation (the bulk approval is keyed to the uploader, not the rate row).

**Step 3 (if A): DDL on `mcaff_prefg_dev` only, then stop.** Hand-written `prisma/add_rate_history_audit_columns.sql`, not re-runnable (MySQL 8, no `IF NOT EXISTS`). Sync `schema.prisma`. Prod waits for its own go-ahead, and the code has to tolerate the columns being missing until then. Because of that, handlers and SELECTs ship **after** prod DDL, not before.

**Step 4: rate dialog on `AuditStamp`.**

## Gates
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`, `npm test`
- Manual check: open History on one SKU, one vendor, one RM rate and one Recipe Archive row, each with a pending, approved and rejected entry where one exists

## Out of scope (flagging, not doing)
- PO History (`PoHistoryDialog`) and Invoice History aren't masters. PO History only records bulk-CSV field changes with no approver. Same stamp later if you want it.
- No backfill of approver for old rate archive rows.
