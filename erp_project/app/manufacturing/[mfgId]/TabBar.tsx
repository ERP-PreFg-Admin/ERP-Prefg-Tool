"use client"

import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"

export type MfgTab =
  | "active" | "on_hold" | "tech_transfer"
  | "misc_cost"
  | "rm_vendor" | "agreed_rates" | "final_costing"

const TABS: { key: MfgTab; label: string; countKey?: "active" | "on_hold" | "tech_transfer" }[] = [
  { key: "active",        label: "Active SKUs",         countKey: "active" },
  { key: "on_hold",       label: "Stopped / On Hold",   countKey: "on_hold" },
  { key: "tech_transfer", label: "Tech Transfers",      countKey: "tech_transfer" },
  { key: "misc_cost",     label: "Misc. Cost" },
  { key: "rm_vendor",     label: "Approved Procurement Rates" },
  { key: "agreed_rates",  label: "Agreed Rates" },
  { key: "final_costing", label: "Agreed Final Costing" },
]

export default function TabBar({
  mfgId, currentTab, statusCounts,
}: {
  mfgId: number
  currentTab: MfgTab
  statusCounts: Record<string, number>
}) {
  const router = useRouter()

  return (
    <Card className="flex flex-wrap items-center gap-1.5 border-b border-border p-2">
      <CardContent className="p-0 flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => router.push(`/manufacturing/${mfgId}?tab=${tab.key}`)}
            className={
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap " +
              (currentTab === tab.key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground")
            }
          >
            {tab.label}
            {tab.countKey && <span className="opacity-70"> ({statusCounts[tab.countKey] ?? 0})</span>}
          </button>
        ))}
      </CardContent>
    </Card>
  )
}
