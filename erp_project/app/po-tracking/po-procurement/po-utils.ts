import { IST } from "@/lib/date"
import type { WarehouseOption } from "./po-types"

export const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0

export const fmtInt = (v: string | number | null | undefined) =>
  num(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })

export const fmtMoney = (v: string | number | null | undefined) => {
  const n = num(v)
  if (n === 0) return "—"
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`
  return `₹${n.toLocaleString("en-IN")}`
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-CA", { timeZone: IST }) : "—"

export const fmtRate = (v: string | number | null | undefined) => {
  const n = num(v)
  if (n === 0) return "—"
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

export const isImpromptu = (po_no: string) => po_no.startsWith("IMP-")

/* ── Destination dropdown ──────────────────────────────────────────────────── */

/**
 * The warehouses a PO for this legal entity can be sent to.
 *
 * purchaseOrdersSql.warehouseOptions returns one row per (site, entity), because
 * every location runs under both Pep and Kreative with a different Unicommerce
 * facility. A SKU belongs to exactly one entity, so offering the other entity's
 * rows means picking a destination whose facility the PO can never inward into —
 * lib/queries/warehouse.ts facilityByDestinationAndPan finds nothing and the
 * inward mail goes out with no Uniware document.
 *
 * The rules, in the order they matter:
 *
 *  - **A site with no per-entity row stays selectable for everyone.** Its
 *    entity_code is NULL, which means "not configured yet", not "belongs to no
 *    one". Hiding it would remove a destination with no message explaining why.
 *  - **`entityCode` NULL means don't narrow.** An unattributed SKU or a brand with
 *    no entity gets every site — the same allow-when-unknown convention the brand
 *    scope predicates use.
 *  - **One entry per site name**, since `destination` stores the name and two rows
 *    with the same name would be indistinguishable in the dropdown. A row naming
 *    the entity wins over an unconfigured one, because it carries the facility.
 *  - **With no entity, no facility code is shown.** Which entity's facility applies
 *    is genuinely unknown, and a plausible-looking wrong code is worse than none.
 *
 * Input order is preserved (the query sorts mother warehouses first).
 */
export function warehousesForEntity(
  options: WarehouseOption[],
  entityCode: string | null | undefined
): WarehouseOption[] {
  const byName = new Map<string, WarehouseOption>()
  for (const w of options) {
    // Another entity's row — but a NULL entity_code is "unconfigured", so it stays.
    if (entityCode && w.entity_code && w.entity_code !== entityCode) continue
    const prev = byName.get(w.name)
    if (!prev || (!prev.entity_code && w.entity_code)) byName.set(w.name, w)
  }
  const rows = [...byName.values()]
  if (entityCode) return rows
  // Nothing to narrow by, so a two-entity site collapsed to a single option and
  // the surviving row's facility_code is just whichever came first. Claiming it
  // would name a destination the goods may never reach — but going silent left
  // the option reading "Mumbai (MWH)", which says nothing about where it lands.
  // So the one code is cleared and ALL of the site's facilities ride along for
  // the label to name, each tagged with whose it is.
  return rows.map((w) => {
    if (!w.entity_code) return w
    const siteFacilities = options
      .filter((o) => o.name === w.name && o.entity_code)
      .map((o) => ({ entity_code: o.entity_code as string, facility_code: o.facility_code }))
    return { ...w, entity_code: null, facility_code: null, siteFacilities }
  })
}

/**
 * "Gurgaon (GGN, MWH) · GGN_WAREHOUSE"
 *
 * The site's own short code (master_warehouse.code) leads the parens: the city
 * alone doesn't say which of our sites it is, and the code is what people quote
 * to each other. It is optional on the warehouse master, so a site without one
 * simply reads "Gurgaon (MWH) · …" as before rather than showing an empty slot.
 *
 * The facility code is shown because it is what the warehouse and Uniware both
 * key on, and picking the wrong site is otherwise only discovered at inwarding.
 * When the entity IS known and the facility is missing, that gap is called out
 * rather than left blank — an unset facility breaks the inward flow later, and the
 * dropdown is the last place anyone looks at these together.
 *
 * With NO entity to narrow by (an unattributed SKU) the site's facilities are
 * all named, each tagged with whose it is:
 *
 *   "Mumbai (MUM, MWH) · PEP MUM_WAREHOUSE2 / KREATIVE HYP_B2B_MUM2"
 *
 * — see siteFacilities on WarehouseOption. Showing one of them unlabelled would
 * read as a promise about where the goods go that nothing here can make.
 *
 * The zone is deliberately absent. It used to read "Gurgaon — North (MWH)", but
 * `name` is the city, so the zone restated what the city already says and pushed
 * the useful part off the end of a closed <select>. Still on the /masters/warehouses
 * table, where there is room for it and it is a filter.
 */
export function warehouseLabel(w: WarehouseOption): string {
  const site = `${w.name} (${w.code ? `${w.code}, ` : ""}${w.type})`

  if (w.siteFacilities?.length) {
    const all = w.siteFacilities
      .map((f) => `${f.entity_code} ${f.facility_code ?? "facility not set"}`)
      .join(" / ")
    return `${site} · ${all}`
  }

  const facility = w.facility_code
    ? ` · ${w.facility_code}`
    : w.entity_code ? " · facility not set" : ""
  return `${site}${facility}`
}

/** Stable React key. `id` repeats across a site's per-entity rows. */
export const warehouseKey = (w: WarehouseOption) => `${w.id}-${w.entity_code ?? "any"}`

/* ── The destination FILTER ─────────────────────────────────────────────────── */
/*
 * A location is one row of master_warehouse but TWO destinations: Pep's Mumbai
 * facility (MUM_WAREHOUSE2) and Kreative's (HYP_B2B_MUM2) are different places to
 * send goods, and the list should be filterable to one or the other.
 *
 * The filter therefore keeps every (site, entity) row as its own option, unlike
 * warehousesForEntity, which collapses them because the SKU has already decided
 * the entity there. `purchase_orders.destination` stores only the shared site name,
 * so the entity half comes from the PO's own SKU via the ent join — which is why
 * the option value carries both and the query filters on both.
 */

/** Separator for the encoded option value. `|` cannot appear in a warehouse name
 *  or an entity code, both of which are alphanumeric-with-spaces in practice. */
const FILTER_SEP = "|"

/** "Mumbai|PEP" — or just "Mumbai" for a site with no per-entity row. */
export const destFilterValue = (w: WarehouseOption) =>
  w.entity_code ? `${w.name}${FILTER_SEP}${w.entity_code}` : w.name

/** Split an encoded value back into the two URL params. Tolerates a bare name, so
 *  a bookmark from before this existed still filters by site alone. */
export function parseDestFilter(value: string): { destination: string; destEntity: string } {
  const at = value.indexOf(FILTER_SEP)
  if (at === -1) return { destination: value, destEntity: "" }
  return { destination: value.slice(0, at), destEntity: value.slice(at + 1) }
}

/** Rebuild the option value from the two URL params, to mark the <select>. */
export const destFilterSelection = (destination: string, destEntity: string) =>
  destination && destEntity ? `${destination}${FILTER_SEP}${destEntity}` : destination

/** "Mumbai · PEP — MUM_WAREHOUSE2". The entity is named because in this dropdown
 *  the two Mumbais sit next to each other and the code alone doesn't say whose. */
export function destFilterLabel(w: WarehouseOption): string {
  if (!w.entity_code) return `${w.name} (${w.type})`
  const facility = w.facility_code ? ` — ${w.facility_code}` : " — facility not set"
  return `${w.name} · ${w.entity_code}${facility}`
}

export function getPageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total]
  if (current >= total - 3) return [1, "…", total - 4, total - 3, total - 2, total - 1, total]
  return [1, "…", current - 1, current, current + 1, "…", total]
}
