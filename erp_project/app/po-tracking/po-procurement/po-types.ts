export type PoStatus =
  | "draft" | "raised" | "punched"
  | "short_closed" | "partially_received" | "received" | "cancelled"

export type PoRow = {
  id: number
  po_no: string
  date: string | null
  sku_code: string | null
  sku_name: string | null
  sku_status: string | null
  /** Which of OUR legal entities sells this PO's SKU, via brand. Null when the
   *  SKU is unattributed or its brand has no entity — see resolveLetterhead. */
  entity_code: string | null
  /** The recipe this PO is against. Null on POs raised before bom_code became a
   *  bulk-upload column, and on anything raised from the Add PO dialog. */
  recipe_id: number | null
  bom_code: string | null
  qty: string | number
  unit_price: string | number | null
  total_amount: string | number | null
  expected_on: string | null
  received_qty: string | number | null
  /* ── Splits ────────────────────────────────────────────────────────────────
   * A split hands part of a PO to child POs. The parent's `qty` never changes —
   * it is what was legally ordered — so everything below is derived from the
   * children at read time. */
  /** Set on a child: the po_no of the PO it was split off. Null on a master. */
  reference_po: string | null
  /** Live (non-cancelled) children. > 0 means this row is a split master. */
  child_count: number
  /** Total quantity handed to those children. */
  split_qty: string | number
  /** Allocated but not yet received — the amber part of the progress bar. */
  pending_split_qty: string | number
  /** This PO's receipts plus all its children's. The figure the table shows. */
  received_total: string | number
  invoice_no: string | null
  /** The rate the supplier's invoice stated, as parsed — for reconciling against
   *  `unit_price` on the inwarding desk. Null when no invoice line points at this
   *  PO, which is every PO that wasn't raised from one. */
  invoice_rate: string | number | null
  /** 1 when the invoice's lines for this PO carry more than one distinct rate, so
   *  `invoice_rate` is the lowest of several rather than the rate. Comes back as
   *  0/1 from MySQL, not a boolean. */
  invoice_rate_mixed: number | null
  /** Unicommerce's PO code for this row — inward POs only, null everywhere else. */
  uniware_po_code: string | null
  /** What Unicommerce last reported for that code. Null when the PO was never
   *  mirrored and when nobody has synced it yet — the timestamp that tells those
   *  apart is on the invoices tab, not here. */
  uniware_status: string | null
  destination: string | null
  /** The Unicommerce facility at `destination` for this PO's entity. Null when
   *  either is unresolved — the site isn't set up for that entity, or the SKU is
   *  unattributed so there's no entity to resolve against. */
  dest_facility_code: string | null
  /**
   * What the row shows. Derived server-side: partial receipts become
   * `partially_received`, and a raised PO the manufacturer hasn't been mailed
   * about yet reads back as `draft` until the send stamps `email_sent_at`.
   */
  status: PoStatus | null
  /**
   * The status actually stored on the row, before either derivation. Only for
   * gating actions the API validates against the stored value — the edit
   * action, which is limited to POs still awaiting approval.
   */
  raw_status: PoStatus | null
  po_type: "normal" | "impromptu" | "inward" | null
  attachment_key: string | null
  csv_source_key: string | null
  email_sent_at: string | null
  mfg_id: number
  mfg_code: string
  mfg_name: string
  mfg_email: string | null
  po_raised_by: number | null
}

export type SkuOption       = { id: number; sku_code: string; name: string; status: string; entity_code: string | null }
/** `registered_name` is the legal entity from details_mfg — the name a supplier
 *  invoice header prints. matchMfg matches on it ahead of `name`. */
export type MfgOption       = { id: number; code: string; name: string; registered_name: string | null }

/**
 * One (warehouse, legal entity) pair — NOT one warehouse.
 *
 * Every location runs under both Pep and Kreative with a different Unicommerce
 * facility, so `id` repeats across rows and cannot be used as a React key on its
 * own. Filter with warehousesForEntity() (po-utils.ts) before rendering.
 */
export type WarehouseOption = {
  id: number
  name: string
  location: string | null
  zone: string | null
  type: "CWH" | "MWH"
  /** master_entity.code. NULL = the site has no per-entity row, so it serves both. */
  entity_code: string | null
  /** The Unicommerce facility this entity inwards into at this site. */
  facility_code: string | null
  /** details_warehouse_entity.ship_to_pincode — the structured 6-digit PIN of
   *  this site's delivery address. Lets matchWarehouse identify the destination
   *  from what the invoice's ship-to block actually printed, instead of fuzzy-
   *  matching a free-text location label. CHAR(6), so MySQL may pad it. */
  ship_to_pincode: string | null
  /** details_warehouse_entity.bill_to_address — free text, no structured PIN
   *  column. Its PIN is what separates the two legal entities at one site, so
   *  matchWarehouse extracts it rather than the master storing it twice. */
  bill_to_address: string | null
}

export type BadgeVariant = "default" | "secondary" | "success" | "warning" | "info" | "destructive" | "outline"

export const STATUS_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  draft:              { label: "Draft",               variant: "outline" },
  raised:             { label: "Raised",              variant: "secondary" },
  // punched:            { label: "Inward POs",           variant: "default" },
  short_closed:       { label: "Short Closed",        variant: "warning" },
  partially_received: { label: "Partially Received",  variant: "info" },
  received:           { label: "Received",            variant: "success" },
  cancelled:          { label: "Cancelled",           variant: "destructive" },
}

export const STATUS_KEYS = Object.keys(STATUS_CONFIG)

/**
 * FG PO Tracking's tab bar. "punched" is deliberately absent: it labels inward
 * POs, which have their own page (/po-tracking/po-inwarding), and this page
 * already filters them out of every query. STATUS_CONFIG still carries the
 * status so a punched row anywhere else renders with the right badge.
 */
// "open" is the same pseudo-status the inwarding desk uses (statusMatchValues in
// lib/queries/purchase-orders.ts) — everything still awaiting goods, in one tab.
export const TABS = ["all", "open", ...STATUS_KEYS.filter((k) => k !== "punched")] as const
export type TabKey = (typeof TABS)[number]

/* ── Inwarding detail panel ───────────────────────────────────────────────── */

/** Order-side reconciliation numbers. Read from the order, not the loaded row,
 *  so the panel renders for a PO that isn't on the current page. */
export type InwardingHeader = {
  id: number
  po_no: string
  status: PoStatus | null
  qty: string | number
  received_qty: string | number | null
  mfg_code: string
  mfg_name: string
}

/** One supplier-invoice line inwarded against the PO. */
export type InwardingLine = {
  invoice_id: number
  invoice_no: string
  invoice_date: string | null
  invoice_total: string | number | null
  attachment_key: string | null
  uniware_po_code: string | null
  created_at: string | null
  created_by_name: string | null
  line_no: number
  /** `created` — this line raised the PO. `received` — booked against an existing one. */
  link_type: "created" | "received"
  sku_code: string | null
  sku_name: string | null
  batch: string | null
  expiry: string | null
  rate: string | number | null
  line_qty: string | number
  line_total: string | number | null
}

export type InwardingResponse = {
  po: InwardingHeader
  lines: InwardingLine[]
  /** received_qty minus the invoiced total. Derived, never correlated — see the
   *  route's header comment for why this is a number and not a list. */
  withoutInvoice: number
}

/**
 * Tab bar for the PO Inwarding page — only the statuses that desk cares about,
 * led by "open": a pseudo-status (never stored) that spans raised + punched +
 * partially_received. See statusMatchValues() in lib/queries/purchase-orders.ts.
 */
// Two statuses are deliberately absent from the inwarding desk's tabs:
//   punched       — STATUS_CONFIG labels it "Inward POs", which read as a
//                   duplicate of the "Inward" tab beside it.
//   short_closed  — not part of this desk's workflow.
// Neither becomes unreachable: punched is counted inside "open", short-closed
// inside "received" (see statusMatchValues), and both are listed under "All".
export const INWARD_TABS = [
  "open", "raised", "partially_received", "received", "inward", "all",
] as const

/** Labels for tabs that aren't a stored status, so aren't in STATUS_CONFIG. */
// Tabs that aren't a stored status need their own label. "inward" is a po_type
// filter, not a status: every PO an invoice ever raised, whatever state it's in.
// Without it those POs are only reachable via Received/All, because an invoice
// books them in already complete.
export const TAB_LABEL: Record<string, string> = { all: "All", open: "Open", inward: "Inward" }

export const PAGE_SIZE = 20

export type ImpromptuForm = {
  sku_code: string
  mfg_id: string
  /** Selected recipe id as a string — it comes off a <Select>. */
  recipe_id: string
  qty: string
  expected_on: string
  destination: string
  reason: string
}

export type EditData = {
  id: number
  mfg_id: number
  sku_code: string
  recipe_id: number | null
  qty: number | string
  unit_price: number | string | null
  expected_on: string | null
  destination: string | null
}

export const EMPTY_FORM: ImpromptuForm = {
  sku_code: "", mfg_id: "", recipe_id: "", qty: "", expected_on: "", destination: "", reason: "",
}

/** One recipe a manufacturer produces a SKU under — /api/v1/purchase-orders/mfg-skus. */
export type RecipeChoice = { recipe_id: number; bom_code: string; status: string | null }
/** `entity_code` narrows the row's destination dropdown — see warehousesForEntity. */
export type MfgSkuOption = { sku_code: string; sku_name: string; boms?: RecipeChoice[]; entity_code: string | null }

export type SplitRow = { destination: string; qty: string }

/** One history_pos row — an audit entry from the PO bulk CSV create/update flow. */
export type PoHistoryRow = {
  id: number
  action_type: "create" | "update"
  field_name: string | null
  old_value: string | null
  new_value: string | null
  changed_on: string | null
  changed_by_name: string | null
}
