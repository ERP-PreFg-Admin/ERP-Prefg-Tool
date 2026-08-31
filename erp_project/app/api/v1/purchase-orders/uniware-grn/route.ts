// POST /api/v1/purchase-orders/uniware-grn — pull Unicommerce's inflow receipts
// (GRNs) for every mirrored PO. One button, no arguments.
//
// Thin on purpose: the work is runGrnSync() in lib/uniware/grn-sync.ts, so the
// scheduled sweep this becomes later calls the same code path rather than a
// second copy. See that file for the never-throw-per-PO contract and for why
// this never writes to purchase_orders.

export const runtime = "nodejs"
// Sequential Uniware calls, 1+N per PO (one list call, then one per receipt).
// The default cutoff is nowhere near enough for a batch.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { uniwareEnabled } from "@/lib/uniware"
import { runGrnSync } from "@/lib/uniware/grn-sync"

export const POST = withGateway({
  access: { pageSlug: "/po-tracking", level: "editor" },
  // A sweep is 1+N outbound calls per PO against a tenant the warehouse is also
  // using. concurrency 1 stops two clicks running two sweeps over the same rows.
  rateLimit: { limit: 6, windowMs: 10 * 60_000, concurrency: 1 },
  handler: async ({ ctx }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }
    return NextResponse.json(await runGrnSync(ctx))
  },
})
