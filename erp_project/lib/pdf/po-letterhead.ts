/**
 * Who a purchase order is FROM, and where it is going.
 *
 * Pep and Kreative share ONE template (lib/pdf/po-document.tsx). Everything that
 * differs between them is resolved here, from the PO's own SKU:
 *
 *   sku_code → master_skus.brand_id → master_brand.entity_id → master_entity
 *              (legal name, bank details)
 *   + destination → master_warehouse → details_warehouse_entity
 *              (bill-to and ship-to, per site AND entity)
 *
 * Separate from the template rather than inlined, for two reasons that survive the
 * templates being merged: the fallback ladder below is the part with actual rules in
 * it, and this module is pure — no `@/lib/db`, no `@react-pdf/renderer` — so
 * tests/unit/po-letterhead.test.ts covers those rules with no credentials, no font
 * registration and no PDF rendering. Same reason lib/po-split.ts was extracted from
 * its route.
 *
 * The template renders already-resolved strings and never looks at a raw row.
 */

/** One row of purchaseOrdersSql.selectForEmail. */
export type PoEmailRow = {
  po_no: string
  date: string | null
  expected_on: string | null
  destination: string | null
  dest_location: string | null
  sku_code: string
  sku_name: string | null
  qty: number | string
  unit_price: number | string | null
  total_amount: number | string | null
  mfg_name: string
  mfg_code: string
  registered_name: string | null
  gst_number: string | null
  location: string | null
  mfg_email: string | null
  raised_by_name: string | null

  // ── Letterhead: master_skus → master_brand → master_entity ────────────────
  // master_entity contributes only the legal name and the bank. The address and
  // GSTIN come from details_warehouse_entity below, which already has them at the
  // right grain — per (site, entity), because GST registration is state-wise.
  entity_code: string | null
  entity_legal_name: string | null
  bank_name: string | null
  bank_account_no: string | null
  bank_ifsc: string | null
  bank_branch: string | null

  // ── Per-site, per-entity: details_warehouse_entity ────────────────────────
  bill_to_name: string | null
  bill_to_address: string | null
  bill_to_gstin: string | null
  ship_to_name: string | null
  ship_to_gstin: string | null
  ship_to_address: string | null
  ship_to_line1: string | null
  ship_to_line2: string | null
  ship_to_city: string | null
  ship_to_state: string | null
  ship_to_pincode: string | null
}

export type PoBank = {
  name: string
  account_no: string
  ifsc: string
  branch: string | null
}

export type PoLetterhead = {
  /** master_entity.code — "PEP" | "KREATIVE" | null. Not used to pick a template
   *  (there is one), but it is how callers and tests tell a resolved letterhead
   *  from the unattributed fallback below. */
  entity_code: string | null
  /** Never empty: the last rung of the ladder guarantees a name. */
  name: string
  address_lines: string[]
  gstin: string | null
  /** null unless name, account number and IFSC are ALL present — see below. */
  bank: PoBank | null
}

export type PoShipTo = {
  name: string | null
  address_lines: string[]
  gstin: string | null
}

/**
 * What every PO printed before entities existed, kept verbatim.
 *
 * Reached only when the SKU's brand resolves to no legal entity. Keeping it means
 * adding this feature changes no existing document until its brand is attributed —
 * so the migration and the data entry are not prerequisites for shipping.
 *
 * tests/unit/po-letterhead.test.ts asserts these strings literally. If you change
 * them, you are changing what an unattributed PO prints; do that on purpose.
 */
export const UNATTRIBUTED_LETTERHEAD = {
  name: "Pep Technologies Pvt Ltd, MCaffeine",
  address_lines: [
    "A1 304, Kanakia Boomerang, Chandivali, Andheri (E),",
    "Mumbai 400072",
  ],
  gstin: "27AAICP2804J1ZC",
} as const

const clean = (v: string | null | undefined): string | null => {
  const s = v?.trim()
  return s ? s : null
}

/**
 * Split a TEXT address column into render-ready lines.
 *
 * Both newline conventions, because these are typed into a textarea and pasted
 * from Word — and blank lines are dropped rather than rendered as a gap, since a
 * trailing newline is the most common thing to leave behind.
 */
const addressLines = (v: string | null | undefined): string[] =>
  (v ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * Who we are on this PO.
 *
 * The address and GSTIN have exactly ONE source: details_warehouse_entity's
 * bill_to_* for this (destination, entity) pair. There is no coarser fallback, and
 * that is the point — GST registration is state-wise, so an entity-level address
 * would be wrong for every delivery outside its home state, and wrong while
 * looking authoritative. If the pair has no bill-to on file the PO prints the
 * correct legal name with no address: visibly incomplete, which is a bug someone
 * reports, rather than the wrong registration, which is a bug that gets filed.
 *
 * The one thing that does fall back is the NAME: bill_to_name, else the entity's
 * legal_name (NOT NULL on master_entity). Both describe the same company, so
 * mixing them cannot misattribute anything.
 *
 * A SKU with no entity at all takes UNATTRIBUTED_LETTERHEAD whole — see below.
 */
export function resolveLetterhead(row: PoEmailRow): PoLetterhead {
  const entityCode = clean(row.entity_code)
  if (!entityCode) {
    return {
      entity_code: null,
      name: UNATTRIBUTED_LETTERHEAD.name,
      address_lines: [...UNATTRIBUTED_LETTERHEAD.address_lines],
      gstin: UNATTRIBUTED_LETTERHEAD.gstin,
      bank: resolveBank(row),
    }
  }

  return {
    entity_code: entityCode,
    // legal_name is NOT NULL on master_entity, so this cannot end up empty.
    name: clean(row.bill_to_name) ?? clean(row.entity_legal_name) ?? entityCode,
    address_lines: addressLines(row.bill_to_address),
    gstin: clean(row.bill_to_gstin),
    bank: resolveBank(row),
  }
}

/**
 * All three of name, account number and IFSC, or nothing.
 *
 * A partial bank block is worse than an absent one: a manufacturer reading an
 * account number with no IFSC will either guess or ring up, and the PDF gives no
 * hint that a field was simply never filled in. Branch is optional — it is
 * decoration, the IFSC identifies the branch.
 */
function resolveBank(row: PoEmailRow): PoBank | null {
  const name = clean(row.bank_name)
  const account_no = clean(row.bank_account_no)
  const ifsc = clean(row.bank_ifsc)
  if (!name || !account_no || !ifsc) return null
  return { name, account_no, ifsc, branch: clean(row.bank_branch) }
}

/**
 * Where the goods go, most specific source first:
 *
 *   1. details_warehouse_entity's structured ship_to_* columns. Per entity because
 *      at Mumbai the two entities ship to physically different sites.
 *   2. ship_to_address — the verbatim record kept alongside the structured
 *      columns, for a site captured as free text.
 *   3. purchase_orders.destination + master_warehouse.location — today's output.
 *
 * ship_to_gstin is the CONSIGNEE registration and is deliberately NOT this
 * entity's: Pep operates most sites, so Kreative rows usually ship under Pep's
 * registration for that state (prisma/schema.prisma, details_warehouse_entity).
 * Print it as given; never substitute the bill-to GSTIN for it.
 */
export function resolveShipTo(row: PoEmailRow): PoShipTo {
  const gstin = clean(row.ship_to_gstin)

  // City, state and pincode on ONE line, the way an Indian address is written:
  // "Mumbai, Maharashtra - 400072". Any of the three may be missing, so the
  // separators are joined in rather than interpolated.
  //
  // ship_to_pincode is CHAR(6): MySQL PADS rather than rejects, so a short value
  // arrives with trailing spaces. clean() strips them — but only because it is
  // applied here; a bare template read would print the padding.
  const cityState = [clean(row.ship_to_city), clean(row.ship_to_state)].filter(Boolean).join(", ")
  const pincode = clean(row.ship_to_pincode)
  const structured = [
    clean(row.ship_to_line1),
    clean(row.ship_to_line2),
    [cityState, pincode].filter(Boolean).join(" - ") || null,
  ].filter((l): l is string => !!l)

  if (structured.length > 0) {
    return { name: clean(row.ship_to_name) ?? clean(row.destination), address_lines: structured, gstin }
  }

  const verbatim = addressLines(row.ship_to_address)
  if (verbatim.length > 0) {
    return { name: clean(row.ship_to_name) ?? clean(row.destination), address_lines: verbatim, gstin }
  }

  return {
    name: clean(row.destination),
    address_lines: [clean(row.dest_location)].filter((l): l is string => !!l),
    gstin,
  }
}
