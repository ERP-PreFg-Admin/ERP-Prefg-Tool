"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, Server, ScrollText, BarChart2 } from "lucide-react"
import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// The hint belongs on the tab, not in a paragraph under the title: the useful
// distinction is which LAYER each tab describes, and that only matters at the
// moment of choosing where to look.
const TABS = [
  { href: "/observability",          label: "Requests", hint: "How the API behaves", icon: Activity },
  { href: "/observability/infra",    label: "Infra",    hint: "How the box behaves", icon: Server },
  { href: "/observability/logs",     label: "Logs",     hint: "What it said",       icon: ScrollText },
  { href: "/observability/business", label: "Business", hint: "What got done",      icon: BarChart2 },
]

export default function ObservabilityTabs() {
  const pathname = usePathname()

  return (
    <TabsList>
      {TABS.map(({ href, label, hint, icon: Icon }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            // Mirrors TabsTrigger's styling — that component renders a <button>,
            // which can't be a navigation target.
            className={cn(
              "group relative flex items-baseline gap-2 px-3 py-2 whitespace-nowrap transition-colors -mb-px border-b-2",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            <Icon className={cn("h-3.5 w-3.5 self-center", active ? "opacity-100" : "opacity-60")} />
            <span className="text-xs font-medium">{label}</span>
            {/* Held back on small screens, where the label alone has to do. */}
            <span className="hidden text-[11px] text-muted-foreground lg:inline">{hint}</span>
          </Link>
        )
      })}
    </TabsList>
  )
}
