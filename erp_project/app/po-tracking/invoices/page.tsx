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
import InvoicesClient from "./InvoicesClient"

export default async function InvoicesPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/invoices")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Every supplier invoice read through PO Inwarding, with the line items it recorded and
          the purchase orders each line was booked to.
        </p>
      </div>
      <InvoicesClient />
    </div>
  )
}
