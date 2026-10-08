"use client"

import { useRouter } from "next/navigation"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OVERVIEW_TABS, type OverviewTab } from "./overview-model"

// Switching tab drops the other tabs' filters on purpose — each tab starts clean.
export function MfgOverviewTabs({ active }: { active: OverviewTab }) {
  const router = useRouter()
  return (
    <Tabs>
      <TabsList>
        {OVERVIEW_TABS.map((t) => (
          <TabsTrigger
            key={t.key}
            active={t.key === active}
            onClick={() => router.push(`?tab=${t.key}`, { scroll: false })}
            className="text-sm"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
