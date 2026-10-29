import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import StickyHeads from "./StickyHeads"

// Gates every /reports page; each report page then also checks its own source page.
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(parseInt(session.user.id), session.user.roles, "/reports")
  if (access === "none") redirect("/auth/unauthorized")

  return <div className="p-6"><StickyHeads>{children}</StickyHeads></div>
}
