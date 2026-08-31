// GatePass — shipping-package-type counts per facility, for one IST day.
//
// The input for writing gatepasses: "this facility, yesterday, N distinct orders
// in package type DRY003". Read-only, and nothing is stored — every view pulls a
// fresh export from Unicommerce. See docs/gatepass-plan.md.
//
// This file is the auth guard and the page chrome only. The facility list is an
// IMPORT, not a query (lib/gatepass/facilities.ts), and the counts are fetched by
// the client one facility at a time — an export is an async job per facility and
// twenty of them cannot fit in one request. GatepassClient owns that loop.

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { FACILITIES, DEFAULT_FACILITY } from "@/lib/gatepass/facilities"
import { istDaysBack } from "@/lib/gatepass/summary"
import { MAX_RANGE_DAYS } from "@/lib/validation/gatepass"
import GatepassClient from "./GatepassClient"

export default async function GatepassPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(Number(session.user.id), session.user.roles, "/gatepass")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">GatePass</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Distinct orders per shipping package type, by invoice date — the count each gatepass
          is written against. Pulled live from Unicommerce; nothing is stored.
        </p>
      </div>
      <GatepassClient
        facilities={[...FACILITIES]}
        defaultFacility={DEFAULT_FACILITY}
        // Yesterday, resolved on the server so the first render is already right.
        // Computed in IST: before 05:30 the browser's own date is still the day
        // before, and the two would disagree. A one-day range by default — the
        // range widens the export window, it does not change what a gatepass is.
        defaultDay={istDaysBack(1)}
        today={istDaysBack(0)}
        maxRangeDays={MAX_RANGE_DAYS}
      />
    </div>
  )
}
