// GET /api/v1/uniware/explorer/facilities
//
// The Uniware facility codes our warehouse master knows about, for the
// explorer's pick list. ~18 rows.
//
// A route rather than a query in the page: app/** may not import lib/queries
// (the erp/ui-data-boundary rule), and app/api/** is the exemption — that IS the
// data layer's entry point.
//
// The list is a SHORTCUT, never a restriction. The tenant has facilities our
// master does not know about, so the explorer's input stays free text and this
// only saves typing — a typo would otherwise read as "this facility has no POs".

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"

export const GET = withGateway({
  access: { pageSlug: "/uniware", level: "viewer" },
  handler: async () => {
    const rows = await query<{
      name: string
      entity_code: string | null
      facility_code: string | null
    }>(purchaseOrdersSql.warehouseOptions, [])

    // One entry per configured (site, entity) pair — the grain a facility code
    // actually has. Rows with no code would be an unselectable blank.
    const seen = new Set<string>()
    const facilities: { code: string; label: string }[] = []
    for (const r of rows) {
      const code = r.facility_code?.trim()
      if (!code || seen.has(code)) continue
      seen.add(code)
      facilities.push({ code, label: `${r.name}${r.entity_code ? ` · ${r.entity_code}` : ""}` })
    }
    facilities.sort((a, b) => a.code.localeCompare(b.code))

    return NextResponse.json({ facilities })
  },
})
