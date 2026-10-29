/**
 * SERVER component for /masters/recipe-master/history.
 *
 * Read-only counterpart to /masters/recipe-master: lists every Recipe version that
 * has been through an approval (a Recipe only gets a history_recipe row once
 * approved — see lib/approvals/module-handlers.ts bomHandler), grouped
 * SKU-wise with who created/updated/approved each version and when.
 */

import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parsePaginationParams } from "@/lib/pagination"
import { getRecipeHistoryPage } from "@/lib/services/masters/recipe"
import RecipeHistoryClient from "./RecipeHistoryClient"

export default async function RecipeHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/masters/recipe-master")
  if (access === "none") redirect("/auth/unauthorized")

  const sp     = await searchParams
  const { page, size, offset } = parsePaginationParams(sp)
  const search = String(sp.search ?? "")

  const { rows, total } = await getRecipeHistoryPage({ page, size, offset, search })

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Recipe Archive</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Fully retired formulations — Recipe versions marked inactive
        </p>
      </div>
      <RecipeHistoryClient
        rows={rows}
        total={total}
        page={page}
        pageSize={size}
        currentSearch={search}
      />
    </div>
  )
}
