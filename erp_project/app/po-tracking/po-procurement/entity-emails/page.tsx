/**
 * SERVER component for /po-tracking/po-procurement/entity-emails.
 *
 * Standalone page (not a dialog) for the vendor/manufacturer contact-email
 * list: reads ?search/?type from the URL, fetches every matching row via
 * lib/services/entity-emails.ts, and the client groups them into one card per list.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { getEntityEmailsPage } from "@/lib/services/entity-emails"
import EntityEmailsClient from "./EntityEmailsClient"

export const dynamic = "force-dynamic"

export default async function EntityEmailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/po-procurement")
  if (access === "none") redirect("/auth/unauthorized")
  const canEdit = access === "editor"

  const sp           = await searchParams
  const search       = String(sp.search ?? "")
  const typeFilter   = String(sp.type ?? "")

  const { rows, vendorOptions, mfgOptions, warehouseOptions, legalEntityOptions, facilities } =
    // Every type is read, so each tab can show its count; the client shows the chosen tab.
    await getEntityEmailsPage(userId, { search, type: "" })

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Emails</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Every list the ERP mails, and who is on it. Anyone can be added (any email address) as To or CC;
          pause a person to skip them without removing them.
        </p>
      </div>
      <EntityEmailsClient
        rows={rows}
        currentSearch={search}
        currentType={typeFilter}
        vendorOptions={vendorOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        legalEntityOptions={legalEntityOptions}
        facilities={facilities}
        canEdit={canEdit}
      />
    </div>
  )
}
