// Unicommerce PO Explorer — what the tenant holds at a facility, and what has
// been received against it.
//
// Read-only, and nothing is stored: every view asks Uniware directly. The
// in-app equivalent of check_uniware_apis/po_grn.py, which is a scratch script
// on one laptop.
//
// ── WHY THIS IS A TOP-LEVEL SLUG AND NOT AN /admin TAB ───────────────────────
// It must be grantable to DEVELOPERS WITHOUT admins inheriting it. resolveAccess
// walks a slug up its parents and stops at the first one the user's own roles
// hold a row for — so "/admin/uniware" with a developer-only row would still let
// any admin in through their "/admin" grant. "/uniware" has no parent, so
// absence of a row IS denial. Same reason /gatepass sits where it does; see
// prisma/add_uniware_explorer_page.sql.
//
// This file is the auth guard and the page chrome only. The facility list and
// the PO data are both fetched by the client — UI does not read the database
// directly (the erp/ui-data-boundary ESLint rule), and each run is up to `limit`
// outbound Uniware calls, which no page render should pay for unasked.

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import UniwareExplorerClient from "./UniwareExplorerClient"

export const dynamic = "force-dynamic"

export default async function UniwareExplorerPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(Number(session.user.id), session.user.roles, "/uniware")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Unicommerce PO Explorer</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Every purchase order the tenant holds at a facility, with what has been received
          against it. Pulled live; nothing is stored, and nothing here is written back.
        </p>
      </div>
      <UniwareExplorerClient />
    </div>
  )
}
