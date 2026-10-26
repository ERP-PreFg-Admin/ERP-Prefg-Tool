import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getVisibleReports } from "@/lib/services/reports/access"
import ReportCatalogue from "./ReportCatalogue"

export default async function ReportsPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const reports = await getVisibleReports(parseInt(session.user.id), session.user.roles)

  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Built on live ERP data, limited to the brands, manufacturers and warehouses you can see.
        </p>
      </div>
      <ReportCatalogue reports={reports} />
    </>
  )
}
