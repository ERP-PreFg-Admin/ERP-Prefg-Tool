// Groups entity_emails rows into the lists the ERP mails: one card per (type, code, legal entity). Pure.

export type ListRow = {
  id: number
  entity_type: string
  entity_code: string
  legal_entity_code: string | null
  status: string
}

type Names = {
  mfg: Map<string, string>
  vendor: Map<string, string>
  /** Warehouse name → its Uniware facility per legal entity. */
  facilities?: Map<string, { entity_code: string; facility_code: string }[]>
}

export type EmailList<T extends ListRow> = {
  key: string
  title: string
  badge: string
  description: string
  /** Uniware facility codes the list covers; warehouse lists only. */
  codes: string[]
  rows: T[]
  active: number
}

/** The page's tabs: one per kind of list, the three special-PO types together. */
export const EMAIL_TABS = [
  { key: "mfg", label: "Manufacturers", types: ["mfg"] },
  { key: "warehouse", label: "Warehouses", types: ["warehouse"] },
  { key: "employee", label: "Colleagues", types: ["employee"] },
  { key: "report", label: "Reports", types: ["report"] },
  { key: "special", label: "Special POs", types: ["npd", "tech_transfer", "cpr"] },
  { key: "vendor", label: "Vendors", types: ["vendor"] },
] as const

/** The tab a stored entity_type belongs to. */
export function tabOf(entityType: string): string {
  return EMAIL_TABS.find((t) => (t.types as readonly string[]).includes(entityType))?.key ?? "mfg"
}

const ORDER = ["mfg", "warehouse", "employee", "report", "npd", "tech_transfer", "cpr", "vendor"]
const SPECIAL: Record<string, string> = { npd: "NPD PO", tech_transfer: "Tech Transfer PO", cpr: "CPR PO" }
const REPORTS: Record<string, [string, string]> = {
  daily_ops: ["Daily ops report", "Daily at 23:59 IST"],
  po_low_open_qty: ["Low open PO quantity", "Daily at 08:00 IST"],
}

function describe(r: ListRow, names: Names): Pick<EmailList<ListRow>, "title" | "badge" | "description"> {
  const code = r.entity_code
  const all = code === "*"
  const mfgName = (c: string) => (names.mfg.get(c) ? `${names.mfg.get(c)} (${c})` : c)
  switch (r.entity_type) {
    case "mfg":
      return { title: mfgName(code), badge: "Manufacturer", description: "PO mails" }
    case "warehouse": {
      return {
        title: (all ? "All warehouses" : code) + (r.legal_entity_code ? ` · ${r.legal_entity_code}` : ""),
        badge: "Warehouse",
        description: r.legal_entity_code ? `Inward invoice notices, ${r.legal_entity_code} only` : "Inward invoice notices",
      }
    }
    case "employee":
      return all
        ? { title: "Every manufacturer", badge: "Colleagues", description: "CC on every manufacturer's PO mail" }
        : names.mfg.has(code)
        ? { title: mfgName(code), badge: "Colleagues", description: "CC on this manufacturer's PO mail" }
        : { title: code, badge: "Colleagues", description: "CC on this warehouse's inward notices" }
    case "report": {
      const [title, description] = REPORTS[code] ?? [code, "Report"]
      return { title, badge: "Report", description }
    }
    case "vendor":
      return { title: names.vendor.get(code) ? `${names.vendor.get(code)} (${code})` : code, badge: "Vendor", description: "On file only; no mail is sent" }
    default: {
      const label = SPECIAL[r.entity_type] ?? r.entity_type
      return {
        title: all ? "Every manufacturer" : mfgName(code),
        badge: label,
        description: `Gets ${label}s instead of the manufacturer`,
      }
    }
  }
}

/** A shared warehouse list covers every facility at the site; an entity-only one covers that facility. */
function facilityCodes(r: ListRow, names: Names): string[] {
  const atSite = r.entity_type === "warehouse" || (r.entity_type === "employee" && !names.mfg.has(r.entity_code) && r.entity_code !== "*")
  if (!atSite || r.entity_code === "*") return []
  return (names.facilities?.get(r.entity_code) ?? [])
    .filter((f) => !r.legal_entity_code || f.entity_code === r.legal_entity_code)
    .map((f) => f.facility_code)
}

export function groupEmailLists<T extends ListRow>(rows: T[], names: Names): EmailList<T>[] {
  const lists = new Map<string, EmailList<T>>()
  for (const r of rows) {
    const key = `${r.entity_type}|${r.entity_code}|${r.legal_entity_code ?? ""}`
    let list = lists.get(key)
    if (!list) {
      list = { key, ...describe(r, names), codes: facilityCodes(r, names), rows: [], active: 0 }
      lists.set(key, list)
    }
    list.rows.push(r)
    if (r.status !== "inactive") list.active++
  }
  const rank = (k: string) => { const i = ORDER.indexOf(k.split("|")[0]); return i < 0 ? ORDER.length : i }
  return [...lists.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.title.localeCompare(b.title))
}
