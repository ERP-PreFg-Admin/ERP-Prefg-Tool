// The MFG Overview list that used to live here moved to
// /po-tracking/mfg-overview (see app/po-tracking/mfg-overview/page.tsx) — the
// sidebar groups it under Production Tracking now. This bare route just
// forwards to the first manufacturer's Cost Manager page (same order as the
// sidebar's MFG Cost Manager list — manufacturingSql.selectActiveForNav).
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { query } from "@/lib/db"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import { getUserScope, scopeParams } from "@/lib/scope"

export const dynamic = "force-dynamic"

export default async function ManufacturingRootPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  // Scoped, so this forwards to the first manufacturer the user may actually
  // see — it used to send everyone to whichever mfg sorted first.
  const scope = await getUserScope(Number(session.user.id))
  const rows = await query<{ id: number; name: string }>(
    manufacturingSql.selectActiveForNav,
    scopeParams(scope.mfgIds)
  )
  const first = rows[0]
  if (!first) redirect("/auth/unauthorized")

  redirect(`/manufacturing/${first.id}`)
}
