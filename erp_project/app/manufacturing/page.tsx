// The MFG Overview list that used to live here moved to
// /po-tracking/mfg-overview (see app/po-tracking/mfg-overview/page.tsx) — the
// sidebar groups it under Production Tracking now. This bare route just
// forwards to the first manufacturer's Cost Manager page (same order as the
// sidebar's MFG Cost Manager list — manufacturingSql.selectActiveForNav).
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getFirstNavMfgId } from "@/lib/services/manufacturing"

export const dynamic = "force-dynamic"

export default async function ManufacturingRootPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  // Scoped: the first manufacturer the user may actually see.
  const first = await getFirstNavMfgId(Number(session.user.id))
  if (first == null) redirect("/auth/unauthorized")

  redirect(`/manufacturing/${first}`)
}
