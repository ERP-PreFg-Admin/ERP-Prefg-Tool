"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard, Database, Factory, CalendarDays,
  Activity, DollarSign, CheckSquare, BarChart2,
  Settings, ChevronLeft, ChevronRight, ChevronDown, LogOut,
  Package, Truck, FlaskConical, Box, Lock, Sun, Moon, Bug, ExternalLink
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useTheme } from "@/components/ThemeProvider"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import { handleSignOut } from "@/app/actions/auth"
import type { AccessLevel } from "@/lib/permissions"

type NavChild = { label: string; href: string }
type NavItem = {
  label: string
  href?: string
  icon: React.ElementType
  children?: NavChild[]
}

/** Where "Issues" goes. Swap this one line if the form is ever replaced. */
const ISSUE_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdgTR52miUyp1yMvUoi1ir5w5UgtXkoG_2fvq0Lofwd4sk6_Q/viewform"

const NAV: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  {
    label: "Masters", icon: Database,
    children: [
      { label: "SKUs",              href: "/masters/skus" },
      { label: "Manufacturers",     href: "/masters/manufacturers" },
      { label: "Vendors",           href: "/masters/vendors" },
      {label: "Material Master",     href:"/masters/material-master"},
      { label: "RM Cost Master",     href: "/masters/raw-materials" },
      { label: "PM Cost Master", href: "/masters/packing-materials" },
      {label: "Recipe Master" , href: "/masters/recipe-master"},
      { label: "Warehouses",         href: "/masters/warehouses" },
    ],
  },
  {
    label: "Production Tracking", icon: Activity,
    children: [
      { label: "MFG Overview",       href: "/po-tracking/mfg-overview" },
      { label: "FG POs Tracking",    href: "/po-tracking/po-procurement" },
      // { label: "RM/PM Procurement", href: "/po-tracking/rm-pm-procurement" },
      { label: "PO Inwarding",      href: "/po-tracking/po-inwarding" },
      { label: "Invoices",          href: "/po-tracking/invoices" },
    ],
  },
  {
    label: "Approvals", href: "/approvals", icon: CheckSquare,
  },
  {
    label: "Administration", href: "/admin", icon: Settings,
  },
]

interface SidebarProps {
  user?: { name?: string | null; email?: string | null }
  mfgs?: { id: number; name: string }[]
  /** Resolved per-slug access, keyed by href (see app/layout.tsx). Missing
   *  keys default to accessible so a slug this map doesn't cover never
   *  accidentally locks a legitimate link. */
  access?: Record<string, AccessLevel>
}

// Sections with more children than this show only the first CHILD_CAP and
// collapse the rest behind a "Show more" toggle — keeps a growing list (e.g.
// manufacturers under MFG Management) from pushing every section below it
// down the sidebar.
const CHILD_CAP = 5

// Drag-to-resize bounds. MIN is where the longest child label ("Approved
// Procurement Rates") stops being readable; MAX is where the sidebar starts
// eating the tables it exists to navigate to. DEFAULT matches the old w-56.
const WIDTH_MIN = 180
const WIDTH_MAX = 400
const WIDTH_DEFAULT = 224
const WIDTH_KEY = "sidebar-width"

export default function Sidebar({ user, mfgs = [], access }: SidebarProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(WIDTH_DEFAULT)
  const [dragging, setDragging] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  // Restored after mount, not during render: localStorage doesn't exist on the
  // server, so reading it inline would render one width on the server and
  // another on the client. Same reasoning as ThemeProvider.
  useEffect(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (stored >= WIDTH_MIN && stored <= WIDTH_MAX) setWidth(stored)
  }, [])

  const commitWidth = (px: number) => {
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)))
    setWidth(clamped)
    localStorage.setItem(WIDTH_KEY, String(clamped))
    return clamped
  }

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    // Measured from the sidebar's own left edge rather than assuming it sits at
    // x=0, so this survives the layout ever gaining something to its left.
    const originX = asideRef.current?.getBoundingClientRect().left ?? 0
    // The pointer will leave the 4px handle immediately; suppressing selection
    // stops the drag from highlighting half the page on the way past.
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"

    const move = (ev: PointerEvent) =>
      setWidth(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, ev.clientX - originX)))

    const stop = (ev: PointerEvent) => {
      setDragging(false)
      document.body.style.userSelect = prevSelect
      commitWidth(ev.clientX - originX)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }

  // Keyboard equivalent — a separator that only responds to a mouse is
  // unreachable for anyone not using one.
  const nudgeWidth = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    commitWidth(width + (e.key === "ArrowRight" ? 16 : -16))
  }
  const [openSections, setOpenSections] = useState<string[]>(["Masters"])
  const [expandedSections, setExpandedSections] = useState<string[]>([])

  // A slug not present in `access` is treated as accessible — it should only
  // ever be missing here if app/layout.tsx's SIDEBAR_SLUGS list falls out of
  // sync with this file's nav, and failing open avoids locking a legitimate
  // link over that mismatch.
  const isLocked = (href?: string) => !!href && access?.[href] === "none"

  // MFG Management's children depend on the live manufacturer list (passed
  // down from the server), so this item is built here rather than living in
  // the static NAV array above. Memoized so its object/array identity stays
  // stable across renders triggered by unrelated state (collapsed toggle,
  // section open/close) — otherwise every <Link> below gets a "new" element
  // each render and Next's viewport-prefetch observer refires for all of
  // them, doubling every sidebar link's prefetch request.
  const nav: NavItem[] = useMemo(() => [
    NAV[0], NAV[1],
    {
      label: "MFG Cost Manager", icon: Factory,
      children: [
        ...mfgs.map(m => ({ label: m.name, href: `/manufacturing/${m.id}` })),
      ],
    },
    ...NAV.slice(2),
  ], [mfgs])

  const toggleSection = (label: string) =>
    setOpenSections(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    )

  const toggleExpanded = (label: string) =>
    setExpandedSections(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    )

  // A child matches if the pathname equals its href or is nested under it
  // (e.g. a detail page not represented as its own nav item). Matching must
  // happen across the WHOLE sidebar at once, not per-section — "/manufacturing"
  // (MFG Overview, under Production Tracking) is a prefix of "/manufacturing/5"
  // (a manufacturer's page, under MFG Cost Manager). Computing the best match
  // separately within each section let both win independently; only the single
  // most specific (longest href) match across every section should ever be lit.
  const allChildren = nav.flatMap(item => item.children ?? [])
  const globalActiveChild = allChildren
    .filter(c => pathname === c.href || pathname.startsWith(c.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]

  const isChildActive = (children: NavChild[], href: string) =>
    globalActiveChild?.href === href && children.some(c => c.href === href)

  const isSectionActive = (item: NavItem) =>
    item.href
      ? pathname === item.href
      : !!globalActiveChild && (item.children ?? []).some(c => c.href === globalActiveChild!.href)

  const { theme, toggle: toggleTheme } = useTheme()

  const initials = user?.name
    ? user.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : "U"

  return (
    <TooltipProvider delayDuration={100}>
      <aside
        ref={asideRef}
        // Width is inline because it's a dragged value, not one of a fixed set
        // of classes. The transition is dropped mid-drag — animating toward
        // every pointermove makes the edge lag the cursor.
        style={collapsed ? undefined : { width }}
        className={cn(
          "relative flex flex-col h-screen bg-sidebar border-r border-sidebar-border ease-in-out shrink-0 overflow-hidden",
          !dragging && "transition-[width] duration-200",
          collapsed && "w-14"
        )}
      >
        {/* Logo row */}
        <div className={cn(
          "flex items-center h-14 border-b border-sidebar-border shrink-0 px-3",
          collapsed ? "justify-center" : "justify-between"
        )}>
          {!collapsed && (
            <span className="flex items-center gap-2 min-w-0">
              <Image src="/pep-wordmark-transparent.png" alt="" width={182} height={64} priority unoptimized className="h-5 w-auto shrink-0" />
              <span className="font-semibold text-2xl text-sidebar-foreground truncate">ERP</span>
            </span>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="p-1.5 rounded-md hover:bg-sidebar-accent text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors shrink-0"
          >
            {collapsed
              ? <ChevronRight className="h-4 w-4" />
              : <ChevronLeft className="h-4 w-4" />
            }
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 scrollbar-none [&::-webkit-scrollbar]:hidden">
          {nav.map(item => {
            const active = isSectionActive(item)
            const hasChildren = (item.children?.length ?? 0) > 0
            const isOpen = openSections.includes(item.label)

            if (!hasChildren) {
              const locked = isLocked(item.href)
              const navLink = locked ? (
                <div
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium cursor-not-allowed",
                    "text-sidebar-foreground/40",
                    collapsed && "justify-center px-0"
                  )}
                >
                  <Lock className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </div>
              ) : (
                <Link
                  href={item.href ?? "#"}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    collapsed && "justify-center px-0"
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              )
              return collapsed || locked ? (
                <Tooltip key={item.label}>
                  <TooltipTrigger asChild>{navLink}</TooltipTrigger>
                  <TooltipContent side="right">{locked ? "No access" : item.label}</TooltipContent>
                </Tooltip>
              ) : (
                <div key={item.label}>{navLink}</div>
              )
            }

            const triggerBtn = (
              <button
                onClick={() => !collapsed && toggleSection(item.label)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  collapsed && "justify-center px-0"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", isOpen && "rotate-180")} />
                  </>
                )}
              </button>
            )

            return (
              <div key={item.label}>
                {collapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{triggerBtn}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ) : (
                  triggerBtn
                )}
                {!collapsed && isOpen && (() => {
                  const children = item.children!
                  const overflowCount = children.length - CHILD_CAP
                  const activeChild = children.find(c => c.href === globalActiveChild?.href)
                  const activeIsHidden = !!activeChild && children.indexOf(activeChild) >= CHILD_CAP
                  const isExpanded = expandedSections.includes(item.label) || activeIsHidden
                  const visibleChildren = overflowCount > 0 && !isExpanded ? children.slice(0, CHILD_CAP) : children

                  return (
                    <div className="ml-6 mt-0.5 mb-1 space-y-0.5 border-l border-sidebar-border pl-3">
                      {visibleChildren.map(child => {
                        const childLocked = isLocked(child.href)
                        if (childLocked) {
                          return (
                            <Tooltip key={child.href}>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-sidebar-foreground/35 cursor-not-allowed">
                                  <Lock className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{child.label}</span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="right">No access</TooltipContent>
                            </Tooltip>
                          )
                        }
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={cn(
                              "block px-2 py-1.5 rounded-md text-sm transition-colors",
                              isChildActive(children, child.href)
                                ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                                : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                            )}
                          >
                            {child.label}
                          </Link>
                        )
                      })}
                      {overflowCount > 0 && (
                        <button
                          onClick={() => toggleExpanded(item.label)}
                          className="block w-full text-left px-2 py-1.5 rounded-md text-sm text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                        >
                          {isExpanded ? "Show less" : `Show more (${overflowCount})`}
                        </button>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </nav>

        {/* Report an issue — a Google Form, not a page in this app, so it opens
            in a new tab and sits outside NAV: it has no page_permissions slug
            and must never be locked. Anyone who can sign in can report a bug. */}
        <div className="px-2 pb-2 shrink-0">
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={ISSUE_FORM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center px-0 py-2 rounded-lg text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
                >
                  <Bug className="h-4 w-4 shrink-0" />
                  <span className="sr-only">Issues</span>
                </a>
              </TooltipTrigger>
              <TooltipContent side="right">Issues</TooltipContent>
            </Tooltip>
          ) : (
            <a
              href={ISSUE_FORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            >
              <Bug className="h-4 w-4 shrink-0" />
              <span className="truncate">Issues</span>
              {/* Signals the link leaves the app before it's clicked. */}
              <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-sidebar-foreground/40" />
            </a>
          )}
        </div>

        {/* User row */}
        <div className={cn(
          "border-t border-sidebar-border p-3 flex items-center gap-2.5 shrink-0",
          collapsed ? "justify-center flex-col" : "justify-between"
        )}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-7 w-7 rounded-full bg-sidebar-primary flex items-center justify-center text-sidebar-primary-foreground text-xs font-semibold shrink-0">
              {initials}
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-xs font-medium text-sidebar-foreground truncate">{user?.name ?? "User"}</p>
                <p className="text-xs text-sidebar-foreground/50 truncate">{user?.email ?? ""}</p>
              </div>
            )}
          </div>

          {/* Theme sits with sign-out rather than in the logo row: this block
              already handles the collapsed rail by stacking, so the toggle
              stays reachable at w-14 where the logo row has no space for it. */}
          <div className={cn("flex items-center gap-0.5 shrink-0", collapsed && "flex-col")}>
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="p-1.5 rounded-md text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            >
              {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>

            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <form action={handleSignOut}>
                    <button
                      type="submit"
                      className="p-1.5 rounded-md text-sidebar-foreground/50 hover:text-destructive hover:bg-sidebar-accent transition-colors"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </TooltipTrigger>
                <TooltipContent side="right">Sign out</TooltipContent>
              </Tooltip>
            ) : (
              <form action={handleSignOut}>
                <button
                  type="submit"
                  className="p-1.5 rounded-md text-sidebar-foreground/50 hover:text-destructive hover:bg-sidebar-accent transition-colors shrink-0"
                  title="Sign out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Resize handle. Hidden while collapsed — there's nothing to drag when
            the rail is a fixed 56px, and the chevron already toggles that.
            The hit area is 4px wide but the visible line only appears on hover
            or drag, so it reads as an edge rather than a border until used. */}
        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={WIDTH_MIN}
            aria-valuemax={WIDTH_MAX}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={nudgeWidth}
            onDoubleClick={() => commitWidth(WIDTH_DEFAULT)}
            title="Drag to resize · double-click to reset"
            className={cn(
              "absolute inset-y-0 right-0 w-1 cursor-col-resize group/resize",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            )}
          >
            <div
              className={cn(
                "h-full w-px ml-auto transition-colors",
                dragging ? "bg-sidebar-ring" : "bg-transparent group-hover/resize:bg-sidebar-ring"
              )}
            />
          </div>
        )}
      </aside>
    </TooltipProvider>
  )
}
