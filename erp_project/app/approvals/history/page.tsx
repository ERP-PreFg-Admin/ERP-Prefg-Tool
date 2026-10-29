// Server component — fetches resolved (approved/rejected) approvals, paginated,
// and passes them to the read-only history client. Counterpart to
// app/approvals/page.tsx (pending approvals).

import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getApprovalHistory } from "@/lib/services/approvals"
import ApprovalHistoryClient from "./ApprovalHistoryClient"

export const dynamic = "force-dynamic"

export default async function ApprovalHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect("/auth/signin")

  const sp = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const moduleFilter = String(sp.module ?? "") || null
  const statusFilter = String(sp.status ?? "") || null

  const h = await getApprovalHistory({ page, size, offset, module: moduleFilter, status: statusFilter })

  return (
    <ApprovalHistoryClient
      approvals={h.approvals}
      total={h.total}
      page={h.page}
      pageSize={h.pageSize}
      currentModule={moduleFilter ?? ""}
      currentStatus={statusFilter ?? ""}
      materialMap={h.materialMap}
    />
  )
}
