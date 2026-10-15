// Server component — fetches all pending approvals and passes them to the
// client for interactive approve / reject actions.
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { resolveAccess } from "@/lib/permissions"
import { getPendingApprovals } from "@/lib/services/approvals"
import { getActiveRmMaterialOptions, getActivePmMaterialOptions, getActiveSkuList } from "@/lib/cached-reference-data"
import { buildMaterialMap } from "./material-map"
import ApprovalsClient from "./ApprovalsClient"

export const dynamic = "force-dynamic"

export default async function ApprovalsPage() {
  const session = await auth()
  if (!session?.user) redirect("/auth/signin")

  const userId = Number(session.user.id)
  const roles  = session.user.roles ?? []
  const access = await resolveAccess(userId, roles, "/approvals")
  if (access === "none") redirect("/auth/unauthorized")

  const [approvals, rmRows, pmRows, skuRows] = await Promise.all([
    getPendingApprovals(),
    getActiveRmMaterialOptions(),
    getActivePmMaterialOptions(),
    // Resolves a gift kit's component lines to SKU codes on the approval card.
    getActiveSkuList(),
  ])

  const isApprover = access === "editor"

  return (
    <ApprovalsClient
      approvals={approvals}
      isApprover={isApprover}
      materialMap={buildMaterialMap(rmRows, pmRows, skuRows)}
      viewerId={userId}
    />
  )
}
