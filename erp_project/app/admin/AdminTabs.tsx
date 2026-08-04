"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Users, ShieldCheck, ScrollText, Database } from "lucide-react"
import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

const TABS = [
  { href: "/admin",             label: "Users",       icon: Users },
  { href: "/admin/permissions", label: "Permissions", icon: ShieldCheck },
  { href: "/admin/data-access", label: "Data Access", icon: Database },
  { href: "/admin/activity",    label: "Activity",    icon: ScrollText },
]

export default function AdminTabs() {
  const pathname = usePathname()

  return (
    <TabsList>
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            // Mirrors TabsTrigger's styling — that component renders a <button>,
            // which can't be a navigation target.
            className={cn(
              "relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium whitespace-nowrap transition-colors -mb-px border-b-2",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        )
      })}
    </TabsList>
  )
}
