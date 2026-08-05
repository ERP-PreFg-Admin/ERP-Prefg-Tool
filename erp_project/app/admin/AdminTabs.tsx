"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Users, ShieldCheck, ScrollText, Database } from "lucide-react"
import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// The blurb belongs on the tab, not in a paragraph under the page title: it is
// the difference between "which screens" and "which rows" that admins get wrong,
// and it is only useful at the moment of choosing where to go.
const TABS = [
  { href: "/admin",             label: "Users",       hint: "Accounts and roles",   icon: Users },
  { href: "/admin/permissions", label: "Permissions", hint: "Which screens",        icon: ShieldCheck },
  { href: "/admin/data-access", label: "Data Access", hint: "Which rows",           icon: Database },
  { href: "/admin/activity",    label: "Activity",    hint: "What happened",        icon: ScrollText },
]

export default function AdminTabs() {
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
