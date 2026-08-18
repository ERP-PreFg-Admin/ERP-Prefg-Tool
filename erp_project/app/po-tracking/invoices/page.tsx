// Invoices — the document-shaped view of inwarding.
//
// A supplier invoice covers many SKUs; our own POs are one SKU each. Inwarding
// turns one invoice into one inward PO per line, so the PO tables show the
// pieces. This page shows the document those pieces came from.
//
// Rows are fetched client-side by InvoiceGroupTable (shared with the inwarding
// desk's Invoice History dialog), so this file is only the auth guard and the
// page chrome. Scoping is enforced server-side in the API, not here — see
// buildInvoiceParams in lib/queries/supplier-invoices.ts.

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { getPoDropdownOptions } from "@/lib/cached-reference-data"
import { getViewScope } from "@/lib/brand-view"
import { filterByScope } from "@/lib/scope"
import InvoicesClient from "./InvoicesClient"

export default async function InvoicesPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/invoices")
  if (access === "none") redirect("/auth/unauthorized")

  // Options for the filter row. getPoDropdownOptions is an unstable_cache with
  // no user component, so it can't scope internally — post-filter, same as the
  // PO Procurement page does.
  const scope = await getViewScope(userId)
  const { mfgs, warehouses } = await getPoDropdownOptions()
  const mfgOptions = filterByScope(mfgs, "id", scope.mfgIds)
  // A site is one row per legal entity, but `destination` stores only the site
  // name — so the dropdown is the distinct names, not the warehouse rows.
  const destinations = [
    ...new Set(filterByScope(warehouses, "name", scope.warehouseNames).map((w) => w.name)),
  ].sort()

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Every supplier invoice read through PO Inwarding, with the line items it recorded and
          the purchase orders each line was booked to.
        </p>
      </div>
      <InvoicesClient mfgOptions={mfgOptions} destinations={destinations} />
    </div>
  )
}
