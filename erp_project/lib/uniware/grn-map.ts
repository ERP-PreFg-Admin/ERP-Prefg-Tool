/**
 * Uniware inflow receipt (GRN) → our shape. PURE: no fetch, no DB, no env, so
 * tests/unit can import it (see AGENTS.md on what a unit test may reach).
 *
 * ── WHY THIS MODULE IS STRICT ────────────────────────────────────────────────
 * From the FINDINGS block in check_uniware_apis/po_grn.py:
 *
 *   "Response shapes are per-endpoint and inconsistent. A wrong key never
 *    errors — it reads as an empty-but-successful record."
 *
 * That is the whole hazard. If `rejectedQuantity` is spelled differently than we
 * expect, a forgiving mapper stores 0 rejected on every GRN forever and nothing
 * anywhere fails — the screen just quietly lies. So this mapper THROWS on a
 * shape it does not recognise instead of defaulting to zero.
 *
 * Throwing is safe here because the sweep never lets one receipt take down the
 * others (see grn-sync.ts): a shape mismatch is reported against its PO and the
 * rest of the run continues. Loud, but contained — the opposite of the default.
 *
 * ── GATE 0 ───────────────────────────────────────────────────────────────────
 * getInflowReceipt had never run live when this was written. FIELDS below is the
 * one place to correct once `po_grn.py --grn-detail <code>` has printed the real
 * keys against a receipt with rejections on it. Nothing else needs to change.
 */

/**
 * The field map. Every Uniware key this module reads, in one block, because it
 * is the part still awaiting live confirmation.
 */
export const FIELDS = {
  /** Receipt header. */
  statusCode: "statusCode",
  vendorInvoiceNumber: "vendorInvoiceNumber",
  /** Epoch MILLISECONDS, not ISO — Uniware mixes formats inside one payload. */
  created: "created",
  items: "inflowReceiptItems",
  /** Per item. */
  sku: "itemSKU",
  quantity: "quantity",
  rejectedQuantity: "rejectedQuantity",
  batchCode: "batchCode",
  expiry: "expiry",
  manufacturingDate: "manufacturingDate",
} as const

/** Thrown when the payload does not match FIELDS — never swallowed into a zero. */
export class UniwareShapeError extends Error {
  constructor(message: string, readonly sawKeys: string[]) {
    super(`${message}. Keys present: ${sawKeys.join(", ") || "(none)"}`)
    this.name = "UniwareShapeError"
  }
}

export type GrnItem = {
  lineNo: number
  skuCode: string | null
  /** Accepted quantity as Uniware reports it. */
  quantity: number
  rejectedQty: number
  batchCode: string | null
  expiry: string | null
  mfgDate: string | null
}

export type Grn = {
  grnCode: string
  statusCode: string | null
  vendorInvoiceNo: string | null
  createdAt: Date | null
  items: GrnItem[]
  totalQty: number
  totalRejectedQty: number
}

const str = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s === "" ? null : s
}

/**
 * A quantity that MUST be there. Absent key ⇒ throw, because "absent" and "zero"
 * are the two readings we cannot afford to confuse.
 */
function requiredNum(obj: Record<string, unknown>, key: string, where: string): number {
  if (!(key in obj)) {
    throw new UniwareShapeError(`${where}: expected a '${key}' field`, Object.keys(obj))
  }
  const n = Number(obj[key])
  if (!Number.isFinite(n)) {
    throw new UniwareShapeError(`${where}: '${key}' is not a number (${String(obj[key])})`, Object.keys(obj))
  }
  return n
}

/**
 * Uniware's `created`: epoch milliseconds. Treating it as an ISO string yields
 * nonsense rather than an error, which is how --detail surfaced it.
 */
export function parseUniwareMillis(v: unknown): Date | null {
  if (v == null || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * `raw` is the object INSIDE the "inflowReceipt" wrapper — unwrapping belongs to
 * the caller, which is the one place that knows this endpoint is wrapped while
 * getPurchaseOrderDetails beside it is flat.
 */
export function mapInflowReceipt(grnCode: string, raw: unknown): Grn {
  if (!raw || typeof raw !== "object") {
    throw new UniwareShapeError(`GRN ${grnCode}: receipt is not an object`, [])
  }
  const r = raw as Record<string, unknown>

  const rawItems = r[FIELDS.items]
  if (!Array.isArray(rawItems)) {
    throw new UniwareShapeError(
      `GRN ${grnCode}: expected '${FIELDS.items}' to be an array`,
      Object.keys(r)
    )
  }

  const items: GrnItem[] = rawItems.map((it, i) => {
    if (!it || typeof it !== "object") {
      throw new UniwareShapeError(`GRN ${grnCode} line ${i + 1}: not an object`, [])
    }
    const o = it as Record<string, unknown>
    const where = `GRN ${grnCode} line ${i + 1}`

    // The SKU is required too: a silently-null sku_code cannot be joined back to
    // our inward PO, so the line would store but reconcile against nothing.
    if (!(FIELDS.sku in o)) {
      throw new UniwareShapeError(`${where}: expected a '${FIELDS.sku}' field`, Object.keys(o))
    }

    return {
      lineNo: i + 1,
      skuCode: str(o[FIELDS.sku]),
      quantity: requiredNum(o, FIELDS.quantity, where),
      rejectedQty: requiredNum(o, FIELDS.rejectedQuantity, where),
      batchCode: str(o[FIELDS.batchCode]),
      expiry: str(o[FIELDS.expiry]),
      mfgDate: str(o[FIELDS.manufacturingDate]),
    }
  })

  const sum = (pick: (i: GrnItem) => number) => items.reduce((t, i) => t + pick(i), 0)

  return {
    grnCode,
    statusCode: str(r[FIELDS.statusCode]),
    vendorInvoiceNo: str(r[FIELDS.vendorInvoiceNumber]),
    createdAt: parseUniwareMillis(r[FIELDS.created]),
    items,
    totalQty: sum((i) => i.quantity),
    totalRejectedQty: sum((i) => i.rejectedQty),
  }
}

/**
 * The list endpoint: flat `inflowReceiptCodes`, bare strings.
 *
 * An absent key here is NOT an error — a PO with no receipts legitimately
 * returns none, and inflowReceiptsCount = 0 is the normal state of a PO nothing
 * has been received against yet.
 */
export function mapInflowReceiptCodes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return []
  const codes = (raw as Record<string, unknown>).inflowReceiptCodes
  if (!Array.isArray(codes)) return []
  return codes.map((c) => str(c)).filter((c): c is string => c !== null)
}
