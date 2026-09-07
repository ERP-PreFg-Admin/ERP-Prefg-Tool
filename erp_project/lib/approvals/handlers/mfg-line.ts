// ── MFG_LINE (re-activating a manufacturer's recipe line) ────────────────────
//
// Only ONE transition needs approval: a line going inactive/discontinued →
// active, because that is what turns costing and PO-raising back on for it.
// Deactivation and every other edit stay direct writes in
// app/api/v1/manufacturing/lines/route.ts.
//
// ── WHY THIS BREAKS THE USUAL "lock to in_review" PATTERN ────────────────────
// Nothing about the line changes when an activation is requested — it stays
// inactive/discontinued (and therefore keeps NOT costing) while the request
// sits in the queue. So there is no entity to lock and no `in_review` status to
// add to the ENUM: an un-activated line is already in a safe state. That makes
// reject a genuine no-op, and approve the only thing that touches the row.

import { manufacturingSql } from "@/lib/queries/manufacturing"
import { type ModuleHandler } from "./types"

export const mfgLineHandler: ModuleHandler = {
  // Reject: the line was never changed on submit, so leave it exactly as it is.
  async setStatus() {},

  // Approve = activate. status → active, effective_to → NULL (open-ended), which
  // is the whole point of the request. The approval_item (status old→'active')
  // is the audit trail; the row only needs the flip.
  async applyAndArchive(conn, entityId) {
    await conn.execute(manufacturingSql.setLineActive, [entityId])
  },
}
