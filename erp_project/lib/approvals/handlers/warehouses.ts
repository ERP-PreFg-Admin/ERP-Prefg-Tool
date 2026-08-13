// ── WAREHOUSE (warehouse master — spans master_warehouse +
// details_warehouse_entity) ──────────────────────────────────────────────────
//
// Closest existing reference is mfgHandler: a master row plus a details table.
// The difference here is that the details table has TWO rows per location, one
// per legal entity, so a flat approval diff has to be routed to the right one.
//
// Diff field naming: plain `location` / `zone` / `state` / `type` / `status` for
// master_warehouse, and `<field>:<ENTITY_CODE>` — `facility_code:PEP`,
// `gstin:KREATIVE` — for a child row. The entity is identified by CODE and not
// by id because ids differ between the test and prod schemas while the codes do
// not, and an approval can be raised on one and approved after a restore.

import type { PoolConnection } from "mysql2/promise"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import { STATUS } from "@/lib/constants"
import { type ModuleHandler, buildFieldMap, type DiffItem } from "./types"

/** The child-row columns a diff may carry. Must stay in step with ENTITY_FIELDS
 *  in app/api/v1/masters/warehouses/route.ts — that one writes the diff, this one
 *  reads it, and a field in one but not the other is silently dropped. */
const ENTITY_FIELDS = [
  "facility_code", "type", "remarks",
  "bill_to_gstin", "bill_to_name", "bill_to_address",
  "ship_to_gstin", "ship_to_name",
  "ship_to_line1", "ship_to_line2", "ship_to_city", "ship_to_state", "ship_to_pincode",
  "ship_to_address",
  "status",
] as const

const isEntityField = (fieldName: string) => fieldName.includes(":")

/** `facility_code:PEP` -> { field: "facility_code", entityCode: "PEP" } */
function splitEntityField(fieldName: string): { field: string; entityCode: string } {
  const idx = fieldName.indexOf(":")
  return { field: fieldName.slice(0, idx), entityCode: fieldName.slice(idx + 1) }
}

/**
 * approval_items.new_value is a VARCHAR, so a field the submitter cleared
 * arrives as "" — and MySQL rejects "" for an INT in strict mode, taking the
 * whole approval down with it. Same trap lib/approvals/handlers/sku.ts:22 hit
 * with filling/mrp. Nothing here is an INT today, but facility_code and gstin
 * being NULL rather than "" matters: the facility resolver tests
 * `facility_code IS NULL OR = ''` and an empty string would read as configured.
 */
const nullIfBlank = (v: string | undefined, current: unknown): string | null =>
  v === undefined ? ((current as string | null) ?? null) : v.trim() === "" ? null : v.trim()

export const warehouseHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(warehouseSql.setStatus, [status, entityId])
  },

  async applyAndArchive(conn, entityId, items) {
    const masterItems = items.filter((i) => !isEntityField(i.field_name))
    const entityItems = items.filter((i) => isEntityField(i.field_name))

    const [rows] = await conn.execute(warehouseSql.selectById, [entityId])
    const cur = (rows as Record<string, unknown>[])[0]
    if (!cur) throw new Error(`Warehouse ${entityId} not found`)

    // Always runs, even when only child rows changed: approving has to clear
    // in_review off the location or it stays locked to further edits.
    const fieldMap = buildFieldMap(masterItems)
    await conn.execute(warehouseSql.update, [
      nullIfBlank(fieldMap.code, cur.code),
      fieldMap.location ?? cur.location,
      fieldMap.state    ?? cur.state ?? null,
      fieldMap.zone     ?? cur.zone,
      fieldMap.type     ?? cur.type,
      nullIfBlank(fieldMap.contact_person, cur.contact_person),
      nullIfBlank(fieldMap.contact_phone, cur.contact_phone),
      nullIfBlank(fieldMap.site_gstin, cur.site_gstin),
      fieldMap.status   ?? STATUS.ACTIVE,
      entityId,
      // `name` is deliberately absent from warehouseSql.update's SET list — it is
      // the join key for POs, invoices and mail routing, so it is never in a diff.
      // `code` IS here: nothing joins on it, so a typo is safe to correct. It is
      // also UNIQUE, so blank must become NULL — '' would collide across rows.
    ])

    await applyEntityRows(conn, entityId, entityItems)
  },
}

/** Group the `<field>:<CODE>` items by entity and upsert one row each. */
async function applyEntityRows(conn: PoolConnection, warehouseId: number, items: DiffItem[]) {
  const byEntity = new Map<string, Record<string, string>>()
  for (const item of items) {
    const { field, entityCode } = splitEntityField(item.field_name)
    if (!(ENTITY_FIELDS as readonly string[]).includes(field)) continue
    const bucket = byEntity.get(entityCode) ?? {}
    bucket[field] = item.new_value
    byEntity.set(entityCode, bucket)
  }

  for (const [entityCode, changed] of byEntity) {
    const [entRows] = await conn.execute(warehouseSql.selectEntityIdByCode, [entityCode])
    const entity = (entRows as { id: number }[])[0]
    if (!entity) throw new Error(`Unknown legal entity code '${entityCode}'`)

    // The current row may not exist — a location gains an entity the first time
    // someone fills its section in. Absent columns then fall back to null rather
    // than to a previous value.
    const [curRows] = await conn.execute(warehouseSql.selectEntityRowByCode, [warehouseId, entityCode])
    const cur = (curRows as Record<string, unknown>[])[0] ?? {}

    await conn.execute(warehouseSql.upsertEntityRow, [
      warehouseId,
      entity.id,
      nullIfBlank(changed.facility_code, cur.facility_code),
      // type is an ENUM: "" must be NULL ("inherit the location's"), or MySQL
      // rejects it in strict mode and takes the whole approval down.
      nullIfBlank(changed.type, cur.type),
      nullIfBlank(changed.bill_to_gstin, cur.bill_to_gstin),
      nullIfBlank(changed.bill_to_name, cur.bill_to_name),
      nullIfBlank(changed.bill_to_address, cur.bill_to_address),
      nullIfBlank(changed.ship_to_gstin, cur.ship_to_gstin),
      nullIfBlank(changed.ship_to_name, cur.ship_to_name),
      nullIfBlank(changed.ship_to_line1, cur.ship_to_line1),
      nullIfBlank(changed.ship_to_line2, cur.ship_to_line2),
      nullIfBlank(changed.ship_to_city, cur.ship_to_city),
      nullIfBlank(changed.ship_to_state, cur.ship_to_state),
      nullIfBlank(changed.ship_to_pincode, cur.ship_to_pincode),
      nullIfBlank(changed.ship_to_address, cur.ship_to_address),
      // Child status is active/inactive only; it does not follow the location
      // through in_review, since the resolver filters on it and an in_review
      // value would silently stop routing.
      changed.status ?? (cur.status as string | undefined) ?? STATUS.ACTIVE,
      nullIfBlank(changed.remarks, cur.remarks),
    ])
  }
}

/** Exported for tests/db/warehouse-approval.test.ts. */
export const __testing = { splitEntityField, nullIfBlank }
