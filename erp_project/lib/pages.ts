/**
 * The canonical list of permission-controlled page slugs.
 *
 * Source of truth for:
 *   - the /admin > Permissions role x page grid (app/admin/permissions)
 *   - sidebar lock resolution (app/layout.tsx SIDEBAR_SLUGS)
 *   - breadcrumb labels (components/TopBar.tsx)
 *
 * Adding a page means adding a row here. Note that lib/permissions.ts walks a
 * slug up its parents, so a child listed here with no row of its own inherits
 * whatever's granted at its parent — only slugs that need a MORE specific grant
 * than their parent need to be seeded.
 *
 * `section` groups the grid; `nav: false` marks slugs that gate a route but
 * aren't sidebar destinations (module placeholders with no page yet).
 */

export type PageEntry = {
  slug: string
  label: string
  section: string
  nav?: boolean
}

export const PAGES: readonly PageEntry[] = [
  { slug: "/",         label: "Dashboard",      section: "General" },
  { slug: "/approvals", label: "Approvals",     section: "General" },
  { slug: "/admin",    label: "Administration", section: "General" },

  { slug: "/masters",                     label: "Masters (all)",        section: "Masters" },
  { slug: "/masters/skus",                label: "SKUs",                 section: "Masters" },
  { slug: "/masters/manufacturers",       label: "Manufacturers",        section: "Masters" },
  { slug: "/masters/vendors",             label: "Vendors",              section: "Masters" },
  { slug: "/masters/material-master",     label: "Material Master",      section: "Masters" },
  { slug: "/masters/raw-materials",       label: "RM Cost Master",       section: "Masters" },
  { slug: "/masters/packing-materials",   label: "PM Cost Master",       section: "Masters" },
  { slug: "/masters/recipe-master",          label: "Recipe Master",        section: "Masters" },

  { slug: "/manufacturing", label: "MFG Cost Manager", section: "Production" },
  { slug: "/po-tracking",                    label: "PO Tracking (all)", section: "Production" },
  { slug: "/po-tracking/mfg-overview",       label: "MFG Overview",      section: "Production" },
  { slug: "/po-tracking/po-procurement",     label: "FG POs Tracking",   section: "Production" },
  { slug: "/po-tracking/rm-pm-procurement",  label: "RM/PM Procurement", section: "Production" },
  { slug: "/po-tracking/po-inwarding",       label: "PO Inwarding",      section: "Production" },
  { slug: "/po-tracking/invoices",           label: "Invoices",          section: "Production" },

  // Seeded in scripts/seed-permissions.ts but no pages exist yet.
  { slug: "/inventory",  label: "Inventory",            section: "Planned", nav: false },
  { slug: "/finance",    label: "Finance & Accounting", section: "Planned", nav: false },
  { slug: "/hr-payroll", label: "HR & Payroll",         section: "Planned", nav: false },
  { slug: "/sales-crm",  label: "Sales & CRM",          section: "Planned", nav: false },
  { slug: "/reports",    label: "Reports & Analytics",  section: "Planned", nav: false },
  { slug: "/settings",   label: "Settings",             section: "Planned", nav: false },
] as const

/** Slugs that are real sidebar destinations — what app/layout.tsx resolves access for. */
export const NAV_SLUGS = PAGES.filter((p) => p.nav !== false).map((p) => p.slug)

/** slug -> label, for breadcrumbs. */
export const PAGE_LABELS: Record<string, string> = Object.fromEntries(
  PAGES.map((p) => [p.slug, p.label])
)

/** Grid section order, derived so a new section needs no second edit. */
export const PAGE_SECTIONS = [...new Set(PAGES.map((p) => p.section))]
