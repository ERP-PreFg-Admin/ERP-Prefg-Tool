/**
 * SERVER component for /po-tracking/po-procurement/entity-emails.
 *
 * Standalone page (not a dialog) for the vendor/manufacturer contact-email
 * list — same pattern as the Recipe/Approval history pages: reads ?page/?size/
 * ?search/?type from the URL, fetches the slice via lib/services/entity-emails.ts,
 * and hands it to a client component.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
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
  const { page, size, offset } = parsePaginationParams(sp)
  const search       = String(sp.search ?? "")
  const typeFilter   = String(sp.type ?? "")

  const { result, vendorOptions, mfgOptions, warehouseOptions, legalEntityOptions } =
    await getEntityEmailsPage(userId, { page, size, offset, search, type: typeFilter })

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Emails</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Vendor, manufacturer and warehouse contact emails, plus the colleagues
          copied on them — by purpose
        </p>
      </div>
      <EntityEmailsClient
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        currentSearch={search}
        currentType={typeFilter}
        vendorOptions={vendorOptions}
        mfgOptions={mfgOptions}
        warehouseOptions={warehouseOptions}
        legalEntityOptions={legalEntityOptions}
        canEdit={canEdit}
      />
    </div>
  )
}
