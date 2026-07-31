// SERVER component placeholder for /po-tracking/dispatch-calendar.
// Same auth/permission gate as the real pages, rendering a "Coming soon" card
// so the sidebar link works. Replace with the real dispatch calendar later.
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"

export default async function DispatchCalendarPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking")
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Dispatch Calendar</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Calendar view of expected dispatches across purchase orders.
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
