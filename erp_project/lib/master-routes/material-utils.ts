import Fuse from "fuse.js"
import { query } from "@/lib/db"
import { approvalsSql } from "@/lib/queries/approvals"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { ApiError } from "@/lib/gateway/errors"
import type { PoolConnection } from "mysql2/promise"

const MAKE_FUZZY_THRESHOLD = 0.3

/**
 * Fuzzy-matches a newly typed RM make against makes already used for the
 * same name + type. Returns the closest existing make if it's a near-typo
 * of `candidateMake` (and not already an exact match), else null.
 */
export async function findFuzzyMakeMatch(
  name: string,
  type: string | null | undefined,
  candidateMake: string,
): Promise<string | null> {
  const candidate = candidateMake.trim()
  if (!name.trim() || !candidate) return null

  const rows = await query<{ make: string }>(rawMaterials.selectMakesByNameType, [name.trim(), type?.trim() || ""])
  const makes = rows.map((r) => r.make).filter((m) => m.toLowerCase() !== candidate.toLowerCase())
  if (makes.length === 0) return null

  const fuse = new Fuse(makes, { threshold: MAKE_FUZZY_THRESHOLD, ignoreLocation: true })
  const [best] = fuse.search(candidate)
  return best?.item ?? null
}

/**
 * Auto-generates the next RM/PM business code (e.g. "RM001", "PM014") when
 * the caller didn't supply one. Queries the live count inside the caller's
 * open transaction, so within a single bulk-import loop each row sees the
 * previous rows' inserts and never repeats a code.
 *
 * rm_code/pm_code have no DB unique constraint (unlike vendors.code /
 * master_mfgs.code), so this doesn't retry-on-collision like the VEN-/MFG-
 * generators — acceptable here since concurrent RM/PM creation is rare.
 */
export async function generateMaterialCode(
  conn: PoolConnection,
  countSql: string,
  prefix: "RM" | "PM",
  name?: string,
  make?:string
): Promise<string> {
  const [rows] = await conn.execute(countSql)
  const total = (rows as { total: number }[])[0].total
  if(prefix == "PM") {
    return `${prefix}-${String(total + 1).padStart(4, "0")}`
  }
  else {
    const namePart =( name ?? "" ).replace(/[^a-zA-Z]/g , "").slice(0, 4).toUpperCase()
    const makePart =( make ?? "" ).replace(/[^a-zA-Z]/g , "").slice(0, 4).toUpperCase()
    return `${prefix}-${namePart}-${makePart}-${String(total + 1).padStart(4, "0")}`
  }
}

/**
 * Auto-generates a vendor code as VEN-<serial>-<XX> (XX = first 2 letters of
 * the vendor name) and inserts the vendor row with it, retrying with the
 * next serial on a rare collision — vendors.code is UNIQUE.
 */
export async function insertVendorWithGeneratedCode(
  conn: PoolConnection,
  insertVendorSql: string,
  countTotalSql: string,
  name: string,
  type: string,
): Promise<{ vendorId: number; code: string }> {
  const suffix = name.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase()
  const [countRows] = await conn.execute(countTotalSql)
  let serial = (countRows as { total: number }[])[0].total
  for (; ; serial++) {
    const code = `VEN-${type.toUpperCase()}-${suffix}-${String(serial+1).padStart(3, "0")}`
    try {
      const [result] = await conn.execute(insertVendorSql, [code, name, type])
      return { vendorId: (result as { insertId: number }).insertId, code }
    } catch (err: unknown) {
      const code2 = (err as { code?: string })?.code
      if (code2 === "ER_DUP_ENTRY") continue
      throw err
    }
  }
}

/**
 * Auto-generates a manufacturer code as MFG-<serial>-<XX> (XX = first 2
 * letters of the name) and inserts the manufacturer row with it, retrying
 * with the next serial on a rare collision — master_mfgs.code is UNIQUE.
 */
export async function insertMfgWithGeneratedCode(
  conn: PoolConnection,
  insertMfgSql: string,
  countTotalSql: string,
  name: string,
): Promise<{ mfgId: number; code: string }> {
  const suffix = name.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase()
  const [countRows] = await conn.execute(countTotalSql)
  let serial = (countRows as { total: number }[])[0].total

  for (; ; serial++) {
    const code = `MFG-${String(serial+1).padStart(3, "0")}-${suffix}`
    try {
      const [result] = await conn.execute(insertMfgSql, [code, name])
      return { mfgId: (result as { insertId: number }).insertId, code }
    } catch (err: unknown) {
      const errCode = (err as { code?: string })?.code
      if (errCode === "ER_DUP_ENTRY") continue
      throw err
    }
  }
}

type RmParamsInput = {
  rm_code?: string | null
  name: string
  make?: string | null
  type?: string | null
  uom?: string | null
  hsn_code?: string | null
  inci_name?: string | null
}

type PmParamsInput = {
  pm_code?: string | null
  name: string
  type?: string | null
  hsn_code?: string | null
  uom?: string | null
  pantone_color?: string | null
}

/** Builds params for rawMaterials.insert/update. `status` defaults to
 *  "in_review" for the normal create-then-approve flow; bulk-approval
 *  handlers pass "active" since the insert IS the approval being applied. */
export async function toRmParams(conn: PoolConnection, r: RmParamsInput, status = "in_review"): Promise<(string | null)[]> {
  return [
    r.rm_code?.trim() || await generateMaterialCode(conn, rawMaterials.countTotal, "RM", r.name, r.make ?? undefined), r.name.trim(),
    r.make?.trim() || null, r.type?.trim() || null,
    r.uom?.trim() || null, status,
    r.hsn_code?.trim() || null, r.inci_name?.trim() || null,
  ]
}

/** Builds params for packingMaterials.insert/update. See toRmParams above for the `status` note. */
export async function toPmParams(conn: PoolConnection, r: PmParamsInput, status = "in_review"): Promise<(string | null)[]> {
  return [
    r.pm_code?.trim() || await generateMaterialCode(conn, packingMaterials.countTotal, "PM"), r.name.trim(),
    r.type?.trim() || null, r.hsn_code?.trim() || null,
    r.uom?.trim() || null, status,
    r.pantone_color?.trim() || null,
  ]
}

type BankingFieldSql = {
  checkDuplicateGst: string
  checkDuplicateIfsc: string
  checkDuplicateAccountNumber: string
}

/**
 * Returns a "<label> "<value>" is already used by <code>" message if
 * gst_number, ifsc_number, or account_number is already used by another
 * manufacturer/vendor — or null if none collide. Shared by
 * manufacturers/route.ts and vendors/route.ts (both entities carry the same
 * 3 banking/tax fields).
 *
 * `excludeId` is 0 on create (nothing to exclude yet) or the entity's own id
 * on update, so a record being edited never flags itself as a duplicate.
 */
export async function findDuplicateBankingField(
  conn: PoolConnection,
  sql: BankingFieldSql,
  fields: { gst_number?: string | null; ifsc_number?: string | null; account_number?: string | null },
  excludeId: number,
): Promise<string | null> {
  const checks: [string | null | undefined, string, string][] = [
    [fields.gst_number,     sql.checkDuplicateGst,            "GST number"],
    [fields.ifsc_number,    sql.checkDuplicateIfsc,           "IFSC code"],
    [fields.account_number, sql.checkDuplicateAccountNumber,  "Account number"],
  ]
  for (const [value, query, label] of checks) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    const [rows] = await conn.execute(query, [trimmed, excludeId])
    const dup = (rows as { code: string }[])[0]
    if (dup) return `${label} "${trimmed}" is already used by ${dup.code}`
  }
  return null
}

/** Throws 409 if any banking field collides — see findDuplicateBankingField. */
export async function assertNoDuplicateBankingFields(
  conn: PoolConnection,
  sql: BankingFieldSql,
  fields: { gst_number?: string | null; ifsc_number?: string | null; account_number?: string | null },
  excludeId: number,
): Promise<void> {
  const dup = await findDuplicateBankingField(conn, sql, fields, excludeId)
  if (dup) throw new ApiError(409, "duplicate", dup)
}

export async function insertApprovalWithItems(
  conn: PoolConnection,
  userId: number,
  module: string,
  entityId: number,
  fields: [string, string][],
): Promise<number> {
  // Always a brand-new record/rate — every caller of this helper inserts a
  // fresh row (RM_MAT/PM_MAT create, or a first-time RM_VRM/RM_RATE/PM_VRM/PM_RATE
  // rate). Edits to an EXISTING row go through applyVendorRateApproval /
  // applyMfgRateApproval below, or the diff-based inline paths in route.ts.
  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, module, entityId, "create"])
  const approvalId = (ar as { insertId: number }).insertId
  for (const [field, val] of fields) {
    if (val) await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", val])
  }
  return approvalId
}

type ExistingRateRow = {
  id: number
  status: string
  curr_rate: unknown
  moq?: unknown
  uom: unknown
  effective_from: unknown
  mfg_id?: unknown
}

type VendorRateInput = {
  curr_rate?: unknown
  moq?: unknown
  rate_uom?: unknown
  effective_from?: string | null
  mfg_id?: unknown
  /** Mandatory reason for this edit (enforced client-side by the Cost Master
   *  edit dialogs) — stored as an approval_item, not a diffed field, and read
   *  back by rmVrmHandler/pmVrmHandler.applyAndArchive to archive into
   *  history_cost_ven.remarks alongside the superseded rate. */
  remarks?: string
}

type MfgRateInput = {
  curr_rate?: unknown
  rate_uom?: unknown
  effective_from?: string | null
  /** See VendorRateInput.remarks — archived into history_cost_mfg.remarks. */
  remarks?: string
}

// Handles the "existing vendor rate" approval path (used by add-rates + rm
// create-full + the RM_VRM/PM_VRM bulk-CSV edit split). Returns the new
// approval id, or null if nothing was submitted (already in review/rejected-
// by-someone-else/pending, or no actual diff).
export async function applyVendorRateApproval(
  conn: PoolConnection,
  userId: number,
  moduleVrm: string,
  existing: ExistingRateRow,
  v: VendorRateInput,
  today: string,
  setVendorRateStatusSql: string,
): Promise<number | null> {
  if (existing.status === "in_review") return null
  if (existing.status === "rejected") {
    const [rejRows] = await conn.execute(approvalsSql.selectLatestRejection, [moduleVrm, existing.id])
    const rej = (rejRows as { raised_by: number }[])[0]
    if (rej && rej.raised_by !== userId) return null
  }
  const [pendingRows] = await conn.execute(approvalsSql.hasPending, [moduleVrm, existing.id])
  if ((pendingRows as { cnt: number }[])[0]?.cnt > 0) return null

  const diff = ([
    ["curr_rate", existing.curr_rate, v.curr_rate],
    ["moq", existing.moq, v.moq],
    ["uom", existing.uom, v.rate_uom],
    ["effective_from", existing.effective_from, v.effective_from ?? today],
    // mfg_id only exists on cost_master_rm_ven (informational vendor→manufacturer
    // tag) — cost_master_pm_ven has no such column, so skip it for PM_VRM.
    ...(moduleVrm === "RM_VRM" ? [["mfg_id", existing.mfg_id, v.mfg_id] as [string, unknown, unknown]] : []),
  ] as [string, unknown, unknown][]).filter(([, o, n]) => String(o ?? "") !== String(n ?? ""))
  if (diff.length === 0) return null

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, moduleVrm, existing.id, "edit"])
  const approvalId = (ar as { insertId: number }).insertId
  for (const [field, oldVal, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, String(oldVal ?? ""), String(newVal ?? "")])
  }
  if (v.remarks?.trim()) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "remarks", "", v.remarks.trim()])
  }
  await conn.execute(setVendorRateStatusSql, ["in_review", existing.id])
  return approvalId
}

// Handles the "existing mfg rate" approval path (used by add-rates for both
// RM and PM + the RM_RATE/PM_RATE bulk-CSV edit split). See
// applyVendorRateApproval above for the return-value contract.
export async function applyMfgRateApproval(
  conn: PoolConnection,
  userId: number,
  moduleMrm: string,
  existing: ExistingRateRow,
  m: MfgRateInput,
  today: string,
  setRateStatusSql: string,
): Promise<number | null> {
  if (existing.status === "in_review") return null
  if (existing.status === "rejected") {
    const [rejRows] = await conn.execute(approvalsSql.selectLatestRejection, [moduleMrm, existing.id])
    const rej = (rejRows as { raised_by: number }[])[0]
    if (rej && rej.raised_by !== userId) return null
  }
  const [pendingRows] = await conn.execute(approvalsSql.hasPending, [moduleMrm, existing.id])
  if ((pendingRows as { cnt: number }[])[0]?.cnt > 0) return null

  const diff = ([
    ["curr_rate", existing.curr_rate, m.curr_rate],
    ["uom", existing.uom, m.rate_uom],
    ["effective_from", existing.effective_from, m.effective_from ?? today],
  ] as [string, unknown, unknown][]).filter(([, o, n]) => String(o ?? "") !== String(n ?? ""))
  if (diff.length === 0) return null

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, moduleMrm, existing.id, "edit"])
  const approvalId = (ar as { insertId: number }).insertId
  for (const [field, oldVal, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, String(oldVal ?? ""), String(newVal ?? "")])
  }
  if (m.remarks?.trim()) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "remarks", "", m.remarks.trim()])
  }
  await conn.execute(setRateStatusSql, ["in_review", existing.id])
  return approvalId
}
