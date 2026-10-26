"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty-state"
import { REPORT_CATEGORIES, type ReportEntry } from "@/lib/reports/catalog"

// Searchable list of the reports this viewer may open, grouped by category.
export default function ReportCatalogue({ reports }: { reports: ReportEntry[] }) {
  const [q, setQ] = useState("")

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hits = needle
      ? reports.filter((r) => `${r.name} ${r.question} ${r.category}`.toLowerCase().includes(needle))
      : reports
    return REPORT_CATEGORIES
      .map((c) => ({ category: c, items: hits.filter((r) => r.category === c) }))
      .filter((g) => g.items.length > 0)
  }, [q, reports])

  return (
    <div className="space-y-6">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search reports…"
          className="pl-9"
          aria-label="Search reports"
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          hasFilters={!!q}
          filteredMessage="No reports match your search."
          message="No reports are available to you yet. Access to each report follows access to the page its data comes from."
        />
      ) : (
        groups.map((g) => (
          <section key={g.category} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">{g.category}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.items.map((r) => <ReportCard key={r.id} report={r} />)}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function ReportCard({ report }: { report: ReportEntry }) {
  const body = (
    <Card className={report.built ? "h-full transition-colors hover:border-primary/50" : "h-full opacity-70"}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium">{report.name}</span>
          {!report.built && <Badge variant="secondary" className="shrink-0 text-[10px]">Coming soon</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{report.question}</p>
      </CardContent>
    </Card>
  )
  return report.built
    ? <Link href={`/reports/${report.id}`} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</Link>
    : <div aria-disabled="true">{body}</div>
}
