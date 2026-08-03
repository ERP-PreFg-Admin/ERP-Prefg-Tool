"use client"

import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"

export type MfgTab =
  | "active"
  | "misc_cost"
  | "rm_vendor" | "agreed_rates" | "final_costing"
  | "common_rms" | "vendor_ing_mapping"

const TABS: { key: MfgTab; label: string }[] = [
  { key: "active",             label: "SKUs" },
  { key: "misc_cost",          label: "Misc. Cost" },
  { key: "rm_vendor",          label: "Approved Procurement Rates" },
  { key: "agreed_rates",       label: "Agreed Rates" },
  { key: "final_costing",      label: "Agreed Final Costing" },
  { key: "common_rms",         label: "Common RMs" },
  { key: "vendor_ing_mapping", label: "Vendor Ing Mapping" },
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
            {tab.key === "active" && (
              <span className="opacity-70">
                {" "}({statusCounts.active ?? 0} active / {statusCounts.discontinued ?? 0} discontinued / {statusCounts.inactive ?? 0} inactive)
              </span>
            )}
          </button>
        ))}
      </CardContent>
    </Card>
  )
}
