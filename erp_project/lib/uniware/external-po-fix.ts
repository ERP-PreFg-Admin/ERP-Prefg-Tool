// Fixes one facility's Uniware-only POs in the ERP (docs/uniware-manual-po-autofix-plan.md). One transaction per PO.
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { ApiError } from "@/lib/gateway/errors"
import { UNIWARE_SANDBOX, UNIWARE_USER_NAME } from "@/lib/env"
import { todayIST } from "@/lib/date"
import { getUserScope, inScope, scopeParams, type UserScope } from "@/lib/scope"
import { assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { uniwareExternalPoSql as sql } from "@/lib/queries/uniware-external-po"
import { warehouse } from "@/lib/queries/warehouse"
import { writeInvoiceAndPos } from "@/lib/invoice/invoice-inward"
import { assertInvoiceWritable, assertNoLiveGrn, stageInvoiceRevertRequest } from "@/lib/invoice/invoice-revert"
import { panOf } from "@/lib/invoice/gstin"
import { invoiceInwardSchema } from "@/lib/validation/purchase-orders"
import logger from "@/lib/logger"
import { explorePoDetail } from "./po-explorer"
import { syncGrnsForInvoice } from "./grn-sync"
import { externalPoSince, toCandidate } from "./external-po-sync"
import {
  allocateOpenPos, invoiceNoFromReference, mapPoDetail, sameSkuQty,
  type AllocatedLine, type ExternalPoCandidate, type FixAction, type FixResult, type OpenPo,
} from "./external-po"

const OPEN_IN_UNIWARE = new Set(["CREATED", "APPROVED", "WAITING_FOR_APPROVAL"])
const rowsOf = <T>(r: unknown) => (r as [T[], unknown])[0]
const affected = (r: unknown) => (r as [{ affectedRows: number }, unknown])[0].affectedRows

async function livePo(code: string, facility: string) {
  const d = await explorePoDetail(code, facility)
  return mapPoDetail(d.header, d.items)
}

/** Opens a transaction for one PO, commits unless it is a preview, and always releases. */
async function inTransaction<T>(dryRun: boolean, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const out = await work(conn)
    if (dryRun) await conn.rollback()
    else await conn.commit()
    return out
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Locks the cache row and refuses one another invoice took in the meantime. */
async function lockExternal(conn: PoolConnection, code: string) {
  const [row] = rowsOf<{ id: number; adopted: number }>(await conn.query(sql.selectByCodeForUpdate, [code]))
  if (!row) throw new Error(`${code} is no longer cached; search again.`)
  if (Number(row.adopted)) throw new Error(`${code} was just linked to another invoice.`)
  return row
}

async function claim(conn: PoolConnection, invoiceId: number, externalId: number, code: string) {
  if (affected(await conn.execute(sql.markAdopted, [invoiceId, externalId])) !== 1) {
    throw new Error(`${code} was just linked to another invoice.`)
  }
}

/** The create's writes on the caller's transaction: invoice, receipts, inward POs, link. Exported for the DB test. */
export async function writeInvoiceFromPo(conn: PoolConnection, a: {
  code: string; mfgId: number; invoiceNo: string; po: ReturnType<typeof mapPoDetail>
  destination: string; gstin: string; userId: number; brandIds: UserScope["brandIds"]
}): Promise<{ ok: false; reason: string } | { ok: true; invoiceId: number; lines: AllocatedLine[] }> {
  const ext = await lockExternal(conn, a.code)
  const openPos = rowsOf<OpenPo>(await conn.query(purchaseOrdersSql.openForReceiveByMfg, [a.mfgId, ...scopeParams(a.brandIds)]))
  const { lines, shortfalls } = allocateOpenPos(a.po.items, openPos, a.destination)
  if (shortfalls.length) {
    const what = shortfalls.map((s) => `${s.sku_code} needs ${s.needed}, ${s.available} open`).join("; ")
    return { ok: false, reason: `Not enough open FG POs for ${a.destination}: ${what}. Raise the PO, then run this again.` }
  }
  if (!lines.length) return { ok: false, reason: "Everything on this PO was rejected; nothing to credit." }

  const body = invoiceInwardSchema.parse({
    invoice_no: a.invoiceNo,
    invoice_date: a.po.un_created_at ? todayIST(a.po.un_created_at) : null,
    mfg_id: a.mfgId,
    destination: a.destination,
    currency: "INR",
    buyer_gstin: a.gstin,
    po_ref: a.code,
    line_items: lines.map((l) => ({
      sku_code: l.sku_code, qty: l.qty, unit_price: l.unit_price, rate: l.unit_price, mrp: l.mrp,
      amount: l.unit_price != null ? Math.round(l.unit_price * l.qty * 100) / 100 : null,
      reference_po_id: l.reference_po_id,
    })),
  })
  const written = await writeInvoiceAndPos(conn, body, null, a.userId, new Map())
  await claim(conn, written.invoiceId, ext.id, a.code)
  await conn.execute(supplierInvoicesSql.setUniwarePoCode, [a.code, written.invoiceId])
  const poIds = written.poLines.map((l) => l.id)
  await conn.execute(purchaseOrdersSql.buildSetUniwarePoCode(poIds.length), [a.code, ...poIds])
  return { ok: true, invoiceId: written.invoiceId, lines }
}

/** The relink's writes on the caller's transaction. Exported for the DB test. */
export async function relinkInvoiceToPo(conn: PoolConnection, a: {
  invoiceId: number; invoiceNo: string; fromCode: string | null; toCode: string; userId: number
}) {
  await assertInvoiceWritable(conn, a.invoiceId)
  const ext = await lockExternal(conn, a.toCode)
  if (affected(await conn.execute(sql.relinkInvoice, [a.toCode, a.invoiceId, a.fromCode])) !== 1) {
    throw new Error(`${a.invoiceNo} changed while relinking; search again.`)
  }
  const pos = rowsOf<{ id: number; po_no: string; uniware_po_code: string | null }>(await conn.query(sql.selectInwardPosByInvoice, [a.invoiceId]))
  if (pos.length) await conn.execute(purchaseOrdersSql.buildSetUniwarePoCode(pos.length), [a.toCode, ...pos.map((p) => p.id)])
  for (const p of pos) {
    await conn.execute(purchaseOrdersSql.insertPoHistory, [p.id, p.po_no, "update", "uniware_po_code", p.uniware_po_code, a.toCode, null, a.userId])
  }
  await claim(conn, a.invoiceId, ext.id, a.toCode)
}

/** A Uniware PO with no ERP invoice: make the invoice, credit the FG POs, link it. */
async function createFromPo(r: ExternalPoCandidate, userId: number, scope: UserScope, dryRun: boolean): Promise<FixResult> {
  const base = { uniware_po_code: r.uniware_po_code, facility_code: r.facility_code, mfg_code: r.mfg_code }
  const invoiceNo = invoiceNoFromReference(r.reference_no)
  const skip = (summary: string): FixResult => ({ ...base, invoice_no: invoiceNo, action: "skip", done: false, summary })
  if (!invoiceNo) return skip("No ReferenceNo on the Uniware PO, so there is no invoice number to file it under.")

  const po = await livePo(r.uniware_po_code, r.facility_code)
  if ((po.un_status ?? "").toUpperCase() === "CANCELLED") return skip("Cancelled in Uniware since the search.")
  const [fac] = await query<{ destination: string; gstin: string | null }>(sql.selectFacilityEntity, [r.facility_code])
  if (!fac?.gstin) return skip(`${r.facility_code} has no GSTIN on /masters/warehouses.`)

  const { fix, invoiceId } = await inTransaction(dryRun, async (conn): Promise<{ fix: FixResult; invoiceId?: number }> => {
    const w = await writeInvoiceFromPo(conn, {
      code: r.uniware_po_code, mfgId: r.mfg_id, invoiceNo, po, destination: fac.destination, gstin: fac.gstin!,
      userId, brandIds: scope.brandIds,
    })
    if (!w.ok) return { fix: skip(w.reason) }
    const units = w.lines.reduce((t, l) => t + l.qty, 0)
    const received = po.items.some((i) => Number(i.received_qty ?? 0) > 0)
    return {
      invoiceId: w.invoiceId,
      fix: {
        ...base, invoice_no: invoiceNo, action: "create", done: !dryRun,
        summary: `New invoice ${invoiceNo} for ${fac.destination}: ${units.toLocaleString("en-IN")} units ` +
          `(${received ? "GRN accepted" : "PO qty, nothing received yet"}) against ${[...new Set(w.lines.map((l) => l.po_no))].join(", ")}.`,
      },
    }
  })
  // GRNs mirror against the new invoice; the status sync would get there too. Dev reads are pinned to the sandbox.
  if (!dryRun && invoiceId && !UNIWARE_SANDBOX) {
    await syncGrnsForInvoice({ id: invoiceId, uniware_po_code: r.uniware_po_code }, r.facility_code).catch((e) =>
      logger.warn({ module: "UNIWARE_EXTERNAL", code: r.uniware_po_code, err: String(e), message: "GRN mirror after auto invoice failed" }))
  }
  return fix
}

/** A live ERP invoice on another Uniware PO: relink when nothing would change, else ask for a revert. */
async function fixReplacement(r: ExternalPoCandidate, userId: number, dryRun: boolean): Promise<FixResult> {
  const base = { uniware_po_code: r.uniware_po_code, facility_code: r.facility_code, mfg_code: r.mfg_code, invoice_no: r.live_invoice_no }
  const result = (action: FixAction, summary: string, done = false): FixResult => ({ ...base, action, done, summary })

  const [inv] = await query<{ id: number; invoice_no: string; destination: string | null; buyer_gstin: string | null; uniware_po_code: string | null; mfg_name: string }>(
    sql.selectLiveInvoiceByNo, [r.mfg_id, r.live_invoice_no],
  )
  if (!inv) return result("skip", `ERP invoice ${r.live_invoice_no} is no longer live; search again.`)
  // A correction is keyed by a person; one the ERP made is a leftover (or a PO just relinked away from).
  if (UNIWARE_USER_NAME && (r.un_created_by ?? "").toLowerCase() === UNIWARE_USER_NAME.toLowerCase()) {
    return result("manual", `${r.uniware_po_code} was made by the ERP and ${inv.invoice_no} is on ${inv.uniware_po_code}. Cancel ${r.uniware_po_code} in Uniware.`)
  }
  const pan = inv.buyer_gstin?.trim() ? panOf(inv.buyer_gstin.trim()) : null
  const [wh] = pan && inv.destination
    ? await query<{ facility_code: string | null }>(warehouse.facilityByDestinationAndPan, [inv.destination, pan])
    : []
  const invFacility = wh?.facility_code?.trim() || null

  const po = await livePo(r.uniware_po_code, r.facility_code)
  if ((po.un_status ?? "").toUpperCase() === "CANCELLED") return result("skip", "Cancelled in Uniware since the search.")
  // Live, not cached: the ERP's own PO may have been received since the last sync.
  const old = inv.uniware_po_code && invFacility ? await livePo(inv.uniware_po_code, invFacility) : null
  if (old && Number(old.grn_count) > 0) {
    return result("manual", `Duplicate: ${inv.invoice_no} is received on ${inv.uniware_po_code}. Cancel ${r.uniware_po_code} in Uniware.`)
  }

  const lines = await query<{ sku_code: string | null; qty: number }>(sql.selectInvoiceLines, [inv.id])
  await assertSkuCodesInBrandScope(userId, lines.map((l) => l.sku_code ?? ""))

  if (invFacility === r.facility_code && sameSkuQty(lines, po.items)) {
    return inTransaction(dryRun, async (conn) => {
      await relinkInvoiceToPo(conn, { invoiceId: inv.id, invoiceNo: inv.invoice_no, fromCode: inv.uniware_po_code, toCode: r.uniware_po_code, userId })
      const stillOpen = old && OPEN_IN_UNIWARE.has((old.un_status ?? "").toUpperCase())
      return result("relink",
        `Relinked ${inv.invoice_no} from ${inv.uniware_po_code ?? "no PO"} to ${r.uniware_po_code}; quantities unchanged.` +
        (stillOpen ? ` ${inv.uniware_po_code} is still ${old!.un_status} in Uniware; cancel it there.` : ""),
        !dryRun)
    })
  }

  const why = invFacility !== r.facility_code
    ? `it is at ${r.facility_code}, the ERP invoice at ${invFacility ?? inv.destination ?? "an unmapped warehouse"}`
    : "its SKUs or quantities differ from the ERP invoice"
  await assertNoLiveGrn(inv)
  const reason = `Replaced in Uniware by ${r.uniware_po_code}: ${why}. Re-added from that PO by Find Uniware-only POs once approved.`
  return inTransaction(dryRun, async (conn) => {
    const { approvalId } = await stageInvoiceRevertRequest(conn, inv, userId, reason, dryRun)
    return result("revert_request",
      `Revert of ${inv.invoice_no} ${dryRun ? "to be requested" : `requested (approval #${approvalId})`}: ${why}. ` +
      `Once someone else approves it, the next run re-adds it from ${r.uniware_po_code}.`,
      !dryRun)
  })
}

/** budgetMs keeps the request under the route's maxDuration; what is cut off is fixed on the next press. */
/** `only` limits an apply to the codes its preview showed. */
export async function fixFacility(facility: string, userId: number, dryRun: boolean, budgetMs = 240_000, only?: string[]) {
  const started = Date.now()
  const scope = await getUserScope(userId)
  const wanted = only ? new Set(only) : null
  const rows = (await query<Parameters<typeof toCandidate>[0]>(sql.selectForFacility, [facility, externalPoSince()]))
    .map(toCandidate)
    .filter((r) => inScope(scope, "mfg", r.mfg_id) && (!wanted || wanted.has(r.uniware_po_code)))

  const fixes: FixResult[] = []
  let partial = false
  for (const r of rows) {
    if (!["missing", "replacement", "duplicate"].includes(r.kind)) continue
    if (Date.now() - started > budgetMs) { partial = true; break }
    const base = { uniware_po_code: r.uniware_po_code, facility_code: r.facility_code, mfg_code: r.mfg_code }
    try {
      if (r.kind === "missing") fixes.push(await createFromPo(r, userId, scope, dryRun))
      else if (r.kind === "replacement") fixes.push(await fixReplacement(r, userId, dryRun))
      else fixes.push({
        ...base, invoice_no: r.live_invoice_no, action: "manual", done: false,
        summary: `Duplicate: ${r.live_invoice_no} is received on ${r.live_invoice_uniware_po_code}. Cancel ${r.uniware_po_code} in Uniware.`,
      })
    } catch (err) {
      // One PO's failure must not cost the facility its other fixes.
      const message = err instanceof ApiError || err instanceof Error ? err.message : String(err)
      const dup = (err as { code?: string })?.code === "ER_DUP_ENTRY"
      fixes.push({
        ...base, invoice_no: invoiceNoFromReference(r.reference_no), action: "skip", done: false,
        summary: dup ? "An invoice with this number was just entered; search again." : message,
      })
    }
  }
  return { facility, partial, fixes }
}
