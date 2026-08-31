/**
 * Shapes returned by the Nanonets invoice extractor (lib/nanonets.ts) and
 * consumed by the Add Invoice dialog. These mirror EXTRACTION_SCHEMA — every
 * field is nullable because the extractor is instructed to return null rather
 * than guess, and a scanned invoice can be missing anything.
 */

export type ParsedLineItem = {
  sku_code:     string | null
  sku_name:     string | null
  batch:        string | null
  mfg_date:     string | null
  expiry:       string | null
  qty:          number | null
  hsn:          string | null
  rate:         number | null
  mrp:          number | null
  discount:     number | null
  amount:       number | null
  gst_percent:  number | null
  total_amount: number | null
}

/** A non-goods charge line — freight, packing, insurance. Has an amount and an
 *  SAC but no quantity or rate, so it is never a line item. */
export type ParsedCharge = {
  label:       string
  amount:      number
  /** Read from the invoice's own HSN/SAC tax summary when that names this
   *  charge's SAC; null otherwise, and the dialog falls back to the goods rate. */
  gst_percent: number | null
  /** SAC printed on the charge line — 996511 is goods transport. */
  sac:         string | null
  /** The invoice's tax summary states the same taxable value for this SAC, so
   *  the amount is confirmed by a second place on the document rather than by a
   *  single line the parser happened to read. */
  verified:    boolean
  /** Tax the summary attributes to this SAC, for display beside the amount. */
  tax_amount:  number | null
}

export type ParsedInvoice = {
  date:             string | null
  invoice_number:   string | null
  eway_bill_number: string | null
  from:             string | null
  destination:      string | null
  vehicle_number:   string | null
  currency:         string | null
  seller_gstin:     string | null
  buyer_gstin:      string | null
  /** "Buyer (Bill to)" block — invoiced party, which is not always the party
   *  the goods ship to. Captured separately from the consignee for that reason. */
  bill_to_name:     string | null
  bill_to_address:  string | null
  bill_to_gstin:    string | null
  bill_to_state:    string | null
  /** "Consignee (Ship to)" block. */
  ship_to_name:     string | null
  ship_to_address:  string | null
  purchase_order:   string | null
  total_amount:     number | null
  line_items:       ParsedLineItem[]
  /** Freight/packing/insurance. Inside total_amount but outside line_items, so
   *  the review screen's sum-vs-total check needs them. Absent from the metered
   *  extractor's output, hence optional. */
  charges?:         ParsedCharge[]
  /** True when the rows' gst_percent was worked out from the invoice total
   *  rather than printed per line. The review screen says so, because otherwise
   *  someone checking a row against the PDF hunts for a rate that isn't there. */
  gst_derived?:     boolean
  /** Anything the extractor returned that isn't one of the fields above. Shown
   *  in the dialog's "Other parsed fields" section so nothing is silently lost. */
  extra:            Record<string, string>
}

/** An existing open PO offered in the dialog's per-line "Reference PO" picker.
 *  Numerics arrive as strings from mysql2's DECIMAL handling. */
export type OpenPoOption = {
  id:           number
  po_no:        string
  /** PO raise date — what the FIFO allocation orders on. */
  date:         string | null
  sku_code:     string | null
  sku_name:     string | null
  /** The SKU's live Recipe(s) — comma-joined when more than one is producible. */
  bom_code:     string | null
  /** How many Recipes are live for this SKU. >1 means an active Recipe and the
   *  discontinued one it superseded are both still producible, nothing records
   *  which a PO was raised against, and the desk has to pick the PO by hand. */
  live_bom_count: number
  qty:          string | number
  received_qty: string | number
  /** For a master, what it hasn't handed to a split — quantity on a child
   *  belongs to that child and is received against it, not against this row. */
  remaining:    string | number
  expected_on:  string | null
  status:       string
  /** Set when this PO is itself a split: the po_no it was split off. */
  reference_po: string | null
}

/** A row in the Invoice History list. Numerics arrive as strings from DECIMAL. */
export type InvoiceHistoryHeader = {
  id:              number
  invoice_no:      string
  invoice_date:    string | null
  currency:        string | null
  destination:     string | null
  invoice_total:   string | number | null
  eway_bill_no:    string | null
  vehicle_no:      string | null
  attachment_key:  string | null
  /** The PO Unicommerce minted for this invoice — one there, one per SKU here.
   *  Null when the mirror was skipped (Uniware not configured). */
  uniware_po_code: string | null
  /** What Unicommerce last reported for that PO, and when we asked. Refreshed by
   *  the Sync button, never on a schedule — so a null timestamp means never
   *  asked, which is not the same as a PO with no status. */
  uniware_status:    string | null
  uniware_synced_at: string | null
  created_at:      string
  mfg_code:        string
  mfg_name:        string
  created_by_name: string | null
  /** Present on the list query only. */
  item_count?:     number
  received_count?: number
  /** Total quantity billed across this invoice's lines — what Short Qty
   *  subtracts the warehouse's accepted + rejected from. */
  billed_qty?:     string | number
  /* ── Goods receipts (grn_uniware), list query only ────────────────────────
   * What the WAREHOUSE accepted, as against invoice_total / item_count above,
   * which are what the manufacturer BILLED. The two disagreeing is the point;
   * nothing reconciles them into one number.
   *
   * All zero for an invoice whose GRNs have never been synced — the same
   * reading as "synced, nothing received yet". uniware_grn_count on the invoice
   * is what distinguishes those two, and NULL there means never asked. */
  grn_count?:          number
  grn_accepted?:       string | number
  grn_rejected?:       string | number
  /** Rejected qty priced from the inward PO's unit_price, which is the
   *  invoice's own rate. Excludes receipt lines that matched no PO of ours. */
  grn_rejected_value?: string | number | null
}

/** One line of a historical invoice, with both PO links resolved. */
export type InvoiceHistoryItem = {
  id:                     number
  line_no:                number
  link_type:              "created" | "received"
  sku_code:               string | null
  parsed_sku_code:        string | null
  sku_name:               string | null
  batch:                  string | null
  mfg_date:               string | null
  expiry:                 string | null
  hsn:                    string | null
  qty:                    string | number
  rate:                   string | number | null
  total_amount:           string | number | null
  /** The inward PO this line raised. */
  po_id:                  number | null
  po_no:                  string | null
  po_status:              string | null
  /** That PO's own rate. Written from `rate` below at inward time, so the two
   *  differing means one was edited since. */
  po_unit_price:          string | number | null
  /* ── Unicommerce's own numbers for this line ──────────────────────────────
   * Only the two with no local equivalent — received and rejected are derived
   * from the goods receipts instead. NULL means never asked; `un_line_synced_at`
   * is what separates that from Uniware reporting a real zero. */
  un_pending_qty?:        string | number | null
  un_qc_pass_qty?:        string | number | null
  un_line_synced_at?:     string | null
  /** The pre-existing PO it was also received against. */
  received_against_po_id: number | null
  received_against_po_no: string | null
  received_against_qty:            string | number | null
  received_against_received_qty:   string | number | null
  /* ── Goods receipts against this line's inward PO ─────────────────────────
   * What the WAREHOUSE accepted, as against `qty` above, which is what the
   * manufacturer billed on this line. Zero also reads as "never synced" — the
   * receipts list beside it is what tells those apart. */
  grn_accepted?: string | number
  grn_rejected?: string | number
}

/** One line of one goods receipt, as mirrored into grn_items_uniware. */
export type InvoiceGrnLine = {
  grn_code:          string
  status_code:       string | null
  vendor_invoice_no: string | null
  grn_created_at:    string | null
  line_no:           number
  /** The receipt's SKU, not our invoice line's — they can disagree. */
  sku_code:          string | null
  /** Our inward PO. Null = the warehouse received a SKU we never raised. */
  po_id:             number | null
  po_no:             string | null
  quantity:          string | number
  rejected_qty:      string | number
  batch_code:        string | null
  expiry:            string | null
  mfg_date:          string | null
}

/** One line item after the user has reviewed/corrected it, ready to become a PO. */
export type InwardLineItem = {
  sku_code:     string
  qty:          number
  unit_price:   number | null
  total_amount: number | null
  /** When set, this line books a receipt against that existing PO instead of
   *  creating a new inward PO. */
  reference_po_id: number | null
}
