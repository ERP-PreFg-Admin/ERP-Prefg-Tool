// The module map behind the Logs tab and the Requests route table. Pure: no DB, no AWS.

export type ModuleKey =
  | "purchase-orders"
  | "invoices"
  | "masters"
  | "manufacturing"
  | "approvals"
  | "uniware"
  | "jobs"
  | "admin"
  | "other"

export type ModuleDef = {
  key: ModuleKey
  label: string
  /** Full API path prefixes; the longest match across all modules wins. */
  paths: readonly string[]
  /** Pre-context logger `module` codes. A trailing `*` is a prefix, otherwise exact. */
  codes: readonly string[]
}

export const MODULES: readonly ModuleDef[] = [
  {
    key: "purchase-orders",
    label: "Purchase Orders",
    paths: ["/api/v1/purchase-orders", "/api/v2/purchase-orders", "/api/v2/facilities"],
    codes: ["PO_*"],
  },
  {
    key: "invoices",
    label: "Invoices & Inwarding",
    paths: ["/api/v1/purchase-orders/invoice", "/api/v2/purchase-orders/invoice"],
    codes: ["PO_INVOICE", "INVOICE_*", "NANONETS"],
  },
  {
    key: "masters",
    label: "Masters",
    paths: ["/api/v1/masters"],
    codes: ["SKU*", "VENDOR*", "MFG", "MFG_CREATE", "MFG_UPDATE", "MFG_DOCS", "MFG_BULK", "RM*", "PM*", "BOM*", "WAREHOUSE*"],
  },
  {
    key: "manufacturing",
    label: "Manufacturing",
    paths: ["/api/v1/manufacturing"],
    codes: ["MFG_LINE_*", "MFG_MISC_*", "MFG_FACILITY_*"],
  },
  {
    key: "approvals",
    label: "Approvals",
    paths: ["/api/v1/approvals"],
    codes: ["GET_APPROVAL*", "GET_ENTITY_HISTORY"],
  },
  {
    key: "uniware",
    label: "Uniware & Gatepass",
    paths: ["/api/v1/uniware", "/api/v1/gatepass"],
    codes: ["UNIWARE*", "GATEPASS"],
  },
  {
    // entity-emails is the mail recipient book every PO/invoice/digest mail reads.
    key: "jobs",
    label: "Mail & Jobs",
    paths: ["/api/v1/cron", "/api/v1/webhooks", "/api/v1/entity-emails"],
    codes: ["CRON", "MAILER", "SES_WEBHOOK"],
  },
  {
    key: "admin",
    label: "Admin",
    paths: ["/api/v1/admin"],
    codes: ["ADMIN_*", "OBSERVABILITY"],
  },
  { key: "other", label: "Other", paths: [], codes: [] },
]

export const MODULE_LABEL: Record<ModuleKey, string> = Object.fromEntries(
  MODULES.map((m) => [m.key, m.label])
) as Record<ModuleKey, string>

const stem = (code: string) => (code.endsWith("*") ? code.slice(0, -1) : code)
const codeMatches = (pattern: string, code: string) =>
  pattern.endsWith("*") ? code.startsWith(stem(pattern)) : code === pattern

/** Plain startsWith, the same semantics as CloudWatch's trailing `*`. */
export function moduleForPath(path: string | null | undefined): ModuleKey {
  if (!path) return "other"
  let best: ModuleKey = "other"
  let bestLen = -1
  for (const m of MODULES) {
    for (const p of m.paths) {
      if (path.startsWith(p) && p.length > bestLen) { best = m.key; bestLen = p.length }
    }
  }
  return best
}

/** Longest stem wins, so PO_INVOICE beats PO_*. */
export function moduleForCode(code: string | null | undefined): ModuleKey {
  if (!code) return "other"
  let best: ModuleKey = "other"
  let bestLen = -1
  for (const m of MODULES) {
    for (const c of m.codes) {
      if (codeMatches(c, code) && stem(c).length > bestLen) { best = m.key; bestLen = stem(c).length }
    }
  }
  return best
}

const q = (s: string) => JSON.stringify(s)

/**
 * The CloudWatch JSON filter clause for one module, parenthesised so a caller can
 * `&&` it: its path prefixes, `$.module = "<key>"` for context-stamped lines with no
 * path (cron), and the legacy codes for pre-deploy lines. A longer prefix owned by
 * another module is carved out with `!=`. Null for 'other': negation over every
 * module is too long a pattern to be worth it.
 */
export function cloudWatchModulePattern(key: ModuleKey): string | null {
  const mod = MODULES.find((m) => m.key === key)
  if (!mod || key === "other") return null
  const others = MODULES.filter((m) => m.key !== key)
  const clauses: string[] = []

  for (const p of mod.paths) {
    const carve = others.flatMap((o) => o.paths).filter((x) => x.length > p.length && x.startsWith(p))
    clauses.push([`$.path = ${q(p + "*")}`, ...carve.map((x) => `$.path != ${q(x + "*")}`)].map((c) => `(${c})`).join(" && "))
  }
  clauses.push(`$.module = ${q(key)}`)
  for (const c of mod.codes) {
    const carve = c.endsWith("*")
      ? others.flatMap((o) => o.codes).filter((x) => stem(x).startsWith(stem(c)) && stem(x).length > stem(c).length)
      : []
    clauses.push([`$.module = ${q(c)}`, ...carve.map((x) => `$.module != ${q(x)}`)].map((c2) => `(${c2})`).join(" && "))
  }
  return `(${clauses.map((c) => `(${c})`).join(" || ")})`
}
