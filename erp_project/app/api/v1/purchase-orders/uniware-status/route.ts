// POST /api/v1/purchase-orders/uniware-status — refresh EVERY mirrored PO's
// status AND its goods receipts from Unicommerce. One button, no arguments.
//
// The grain is one call per Uniware PO, not per inward PO: Uniware holds one PO
// per invoice, so the inward POs sharing a code all read the same answer and
// asking once per row would multiply the round trips for nothing.
//
// ── WHY RECEIPTS RIDE ALONG ─────────────────────────────────────────────────
// getPurchaseOrderDetails returns `inflowReceiptsCount` beside `statusCode`, so
// the status pass ALREADY knows, at no extra cost, which POs have receipts. It
// then walks only those — a small subset on any real tenant, because a PO with
// nothing received is the common case.
//
// Doing it here rather than leaving it to /uniware-grn means one button leaves
// both current. A second button people must remember to press in the right
// order is how "rejected 0" comes to mean "nobody synced", which is exactly the
// confusion the receipt columns exist to remove.
//
// The receipt walk is 1+N calls per PO against the status pass's flat 1, so it
// carries its own budget (GRN_BUDGET) inside the same maxDuration. Whatever the
// budget cuts off is REPORTED and left to /uniware-grn, never silently skipped.
//
// Never throws on an individual PO. A tenant that 500s on one code, or a
// destination nobody has mapped a facility for, must not cost the caller the
// other fifty answers — each outcome is reported instead, the way
// pushPurchaseOrders does it.

export const runtime = "nodejs"
// Sequential Uniware calls, one per mirrored PO. The default cutoff is nowhere
// near enough for a batch.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { z } from "zod"
import { query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { supplierInvoicesSql, buildInvoiceParams } from "@/lib/queries/supplier-invoices"
import { uniwareEnabled } from "@/lib/uniware"
import { runStatusSync, MAX_PER_RUN, type StatusSyncRow } from "@/lib/uniware/status-sync"
import { getViewScope } from "@/lib/brand-view"
import { resolveAccess } from "@/lib/permissions"

/** Same slug app/api/v1/admin/* gates on. */
const ADMIN_PAGE = "/admin"

/**
 * The invoices tab's own filter, so "sync these" means the same set as
 * "show these". Every field optional: a body-less POST is still the full sweep
 * the button used to do, which is now admin-only (see the handler).
 *
 * A FILTER, deliberately, not a list of invoice ids. buildInvoiceParams folds
 * the caller's mfg/destination/brand scope into the same predicate the list
 * uses, so a filter can only ever resolve to rows they can already see. A body
 * of ids would need re-checking one at a time — ids are guessable integers, and
 * "it came from a filtered page" guards nothing on a user-supplied body.
 */
const syncFilterSchema = z.object({
  scoped:      z.boolean().optional(),
  search:      z.string().trim().max(200).nullish(),
  mfgCode:     z.string().trim().max(50).nullish(),
  destination: z.string().trim().max(100).nullish(),
  dateFrom:    z.string().trim().max(20).nullish(),
  dateTo:      z.string().trim().max(20).nullish(),
  enteredFrom: z.string().trim().max(20).nullish(),
  enteredTo:   z.string().trim().max(20).nullish(),
})

// The sweep itself, its caps and its per-PO contract live in lib/uniware/status-sync.ts, shared with the cron job.

export const POST = withGateway({
  access: { pageSlug: ["/po-tracking/po-procurement", "/po-tracking/invoices"], level: "editor" },
  schema: syncFilterSchema,
  handler: async ({ body, session, ctx }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }

    // `scoped` is the invoices tab asking for "what I am looking at". Without
    // it this is the unfiltered sweep over everything, which is now a recovery
    // tool rather than a daily one — the nightly job covers normal operation,
    // and at 17 manufacturers this costs minutes. Editor on /po-tracking is not
    // enough for that; /admin is the gate the admin routes already use.
    let rows: StatusSyncRow[]
    if (body.scoped) {
      const scope = await getViewScope(Number(session.user.id))
      const params = buildInvoiceParams(body.search ?? null, scope, {
        mfgCode:     body.mfgCode     ?? null,
        destination: body.destination ?? null,
        dateFrom:    body.dateFrom    ?? null,
        dateTo:      body.dateTo      ?? null,
        enteredFrom: body.enteredFrom ?? null,
        enteredTo:   body.enteredTo   ?? null,
      })
      rows = await query<StatusSyncRow>(supplierInvoicesSql.selectForStatusSyncByFilter, [...params, MAX_PER_RUN + 1])
    } else {
      const level = await resolveAccess(Number(session.user.id), session.user.roles ?? [], ADMIN_PAGE)
      if (level !== "editor") {
        throw new ApiError(403, "forbidden",
          "A full Uniware sweep is admin-only. Use Sync on the invoices tab to refresh what you are viewing.")
      }
      rows = await query<StatusSyncRow>(supplierInvoicesSql.selectAllForStatusSync, [MAX_PER_RUN + 1])
    }

    return NextResponse.json(await runStatusSync(rows, ctx))
  },
})
