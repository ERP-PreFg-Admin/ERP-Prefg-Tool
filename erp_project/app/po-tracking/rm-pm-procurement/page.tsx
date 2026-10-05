// SERVER component placeholder for /po-tracking/rm-pm-procurement.
// Same auth/permission gate as the real pages, but renders a "Coming soon"
// card so the sidebar link works without 404-ing. Replace the body with the
// real RM/PM procurement UI when that module is built.
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"

export default async function RmPmProcurementPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/rm-pm-procurement")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">RM/PM Procurement</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Raw-material &amp; packing-material purchase orders.
        </p>
      </div>
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          🚧 Coming soon — this page is not built yet.
        </CardContent>
      </Card>
    </div>
  )
}
