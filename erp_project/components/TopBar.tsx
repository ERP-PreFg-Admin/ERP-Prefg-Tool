"use client"

import { usePathname } from "next/navigation"
import { Search, Bell, Sun, Moon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useTheme } from "@/components/ThemeProvider"

const LABELS: Record<string, string> = {
  "/":                          "Dashboard",
  "/masters/skus":              "SKUs",
  "/masters/manufacturers":     "Manufacturers",
  "/masters/vendors":           "Vendors",
  "/masters/raw-materials":     "Raw Materials",
  "/masters/packing-materials": "Packaging Material",
  "/manufacturing":             "Manufacturing",
  "/finance":                   "Finance & Accounting",
  "/hr-payroll":                "HR & Payroll",
  "/sales-crm":                 "Sales & CRM",
  "/inventory":                 "Inventory",
  "/reports":                   "Reports & Analytics",
  "/approvals":                 "Approvals",
  "/settings":                  "Settings",
}

export default function TopBar() {
  const pathname = usePathname()
  const label = LABELS[pathname] ?? pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") ?? "Dashboard"
  const { theme, toggle } = useTheme()

  return (
    <header className="h-14 border-b border-border px-6 flex items-center justify-between bg-background shrink-0">
      <span className="text-sm font-medium text-foreground capitalize">{label}</span>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input placeholder="Search…" className="pl-8 w-52 h-8 text-xs" />
        </div>
        <button
          onClick={toggle}
          aria-label="Toggle theme"
          className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
          <Bell className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}
