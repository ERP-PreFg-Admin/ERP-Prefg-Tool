// POST /api/v1/purchase-orders/uniware-documents — pull documents attached on
// each mirrored Uniware PO into our S3, and push our supplier-invoice PDF up.
// One button, no arguments; the sweep decides what is out of sync each direction.
//
// Scoped to TEST_FACILITY for now (runDocumentSync is gated on UNIWARE_SANDBOX),
// so on prod it reports "disabled" and touches nothing.
//
// Never throws for one invoice — see lib/uniware/document-sync.ts. A dead web
// session (the extension needs re-running) comes back as sessionStale, so the UI
// can tell the user to refresh rather than showing a silent zero.

export const runtime = "nodejs"
// Sequential Uniware calls, one mint + list + downloads per invoice.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { uniwareEnabled } from "@/lib/uniware"
import { runDocumentSync } from "@/lib/uniware/document-sync"

export const POST = withGateway({
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ ctx }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }
    const result = await runDocumentSync(ctx)
    return NextResponse.json(result)
  },
})
