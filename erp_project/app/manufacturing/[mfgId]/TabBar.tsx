"use client"

import { useRouter } from "next/navigation"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type MfgTab =
  | "active"
  | "misc_cost"
  | "rm_vendor" | "agreed_rates" | "final_costing"
  | "common_rms" | "vendor_ing_mapping"

const TABS: { key: MfgTab; label: string }[] = [
  { key: "active",             label: "SKU Manager" },
  { key: "misc_cost",          label: "Misc. Cost" },
  { key: "rm_vendor",          label: "Approved Vendor Rates" },
  { key: "agreed_rates",       label: "Agreed Mfg Rates" },
  { key: "final_costing",      label: "Agreed Final Costing" },
  { key: "common_rms",         label: "Common RMs" },
  { key: "vendor_ing_mapping", label: "Vendor Ing Mapping" },
]

export default function TabBar({
  mfgId, currentTab,
}: {
  mfgId: number
  currentTab: MfgTab
}) {
  const router = useRouter()

  return (
    <Tabs>
      <TabsList>
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab.key}
            active={currentTab === tab.key}
            onClick={() => router.push(`/manufacturing/${mfgId}?tab=${tab.key}`)}
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
