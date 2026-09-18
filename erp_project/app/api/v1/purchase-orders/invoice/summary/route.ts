// GET /api/v1/purchase-orders/invoice/summary
// The three-way match rolled up across every invoice the current filter matches
// — not just the page on screen, which is what the list route returns.
//
// Same filter, same scope and the same 15 params as the list, so the strip above
// the table always describes the rows beneath it.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { supplierInvoicesSql, buildInvoiceParams } from "@/lib/queries/supplier-invoices"
import { getViewScope } from "@/lib/brand-view"
import { withGateway } from "@/lib/gateway/with-gateway"
import { parseVerifiedLegs, summariseMatches, type ThreeWayInput } from "@/lib/invoice/three-way"
import type { InvoiceHistoryHeader } from "@/types/invoice"

/** A guard, not a limit — 55 invoices exist today. See selectMatchFields. */
const CAP = 5000

export const GET = withGateway({
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    // Scoped exactly like the list: a summary counting invoices the user cannot
    // open would leak how many exist.
    const scope  = await getViewScope(Number(session.user.id))
    const params = buildInvoiceParams(sp.get("search")?.trim() || null, scope, {
      mfgCode:     sp.get("mfgCode")?.trim()     || null,
      destination: sp.get("destination")?.trim() || null,
      dateFrom:    sp.get("dateFrom")?.trim()    || null,
      dateTo:      sp.get("dateTo")?.trim()      || null,
    })

    const rows = await query<InvoiceHistoryHeader>(
      supplierInvoicesSql.selectMatchFields, [...params, CAP + 1]
    )
    const truncated = rows.length > CAP
    const batch = truncated ? rows.slice(0, CAP) : rows

    const summary = summariseMatches(batch.map((r): ThreeWayInput => ({
      billedQty:       r.billed_qty        ?? 0,
      poCount:         r.po_count          ?? 0,
      poUnlinkedLines: r.po_unlinked_lines ?? 0,
      itemCount:       r.item_count        ?? 0,
      linesValue:      r.lines_value       ?? 0,
      invoiceTotal:    r.invoice_total     ?? 0,
      grnCount:        r.grn_count         ?? 0,
      grnAccepted:     r.grn_accepted      ?? 0,
      grnRejected:     r.grn_rejected      ?? 0,
      verified: parseVerifiedLegs(r.verified_legs),
      // Payment state is deliberately not read here: this strip is the
      // three-way match, and a hand-set payment does not change the documents.
    })))

    return NextResponse.json({ ...summary, truncated, cap: CAP })
  },
})
