import { Suspense } from "react"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getVisibleReports } from "@/lib/services/reports/access"
import { allowedTraceTabs } from "@/lib/services/reports/trace"
import {
  inwardedFigure, invoicedFigure, orderedFigure, overviewFigure, receivedFigure, upkeepFigure, type Figure,
} from "@/lib/services/reports/chain-figures"
import { CHAIN, type Placement } from "@/lib/reports/stations"
import ChainCatalogue, { type FigureSlots } from "./ChainCatalogue"
import ChainFigure, { FigureSkeleton } from "./ChainFigure"

const clock = () => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())

export default async function ReportsPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const roles = session.user.roles
  const [reports, tabs] = await Promise.all([getVisibleReports(userId, roles), allowedTraceTabs(userId, roles)])
  const can = new Set(reports.filter((r) => r.built).map((r) => r.id))
  const entries = CHAIN.filter((e) => can.has(e.reportId) && (!e.tab || tabs.includes(e.tab)))

  // A figure shows only where the viewer can open the report it comes from.
  const slot = (place: Placement, reportId: string, load: () => Promise<Figure>) =>
    can.has(reportId) ? [place, <Suspense key={place} fallback={<FigureSkeleton />}><ChainFigure load={load} /></Suspense>] : null
  const figures = Object.fromEntries([
    slot("overview", "exceptions", () => overviewFigure(userId, roles)),
    slot("ordered", "open-po-book", () => orderedFigure(userId)),
    slot("invoiced", "invoice-checks", () => invoicedFigure(userId)),
    slot("inwarded", "invoice-checks", () => inwardedFigure(userId)),
    slot("received", "traceability", () => receivedFigure(userId)),
    slot("upkeep", "data-quality", () => upkeepFigure(userId, roles)),
  ].filter((s): s is [Placement, React.ReactElement] => s !== null)) as FigureSlots

  return (
    <ChainCatalogue
      entries={entries}
      figures={figures}
      intro={<>
        <h1 className="font-heading text-3xl tracking-tight">Reports</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Each report sits where it looks along the chain. Figures are live and limited to your brands, manufacturers and warehouses.
        </p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">Live · {clock()} IST</p>
      </>}
    />
  )
}
