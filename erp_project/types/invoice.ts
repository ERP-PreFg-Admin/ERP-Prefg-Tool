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
  /** Anything the extractor returned that isn't one of the fields above. Shown
   *  in the dialog's "Other parsed fields" section so nothing is silently lost. */
  extra:            Record<string, string>
}

/** An existing open PO offered in the dialog's per-line "Reference PO" picker.
 *  Numerics arrive as strings from mysql2's DECIMAL handling. */
export type OpenPoOption = {
  id:           number
  po_no:        string
  sku_code:     string | null
  sku_name:     string | null
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
  created_at:      string
  mfg_code:        string
  mfg_name:        string
  created_by_name: string | null
  /** Present on the list query only. */
  item_count?:     number
  received_count?: number
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
  /** The pre-existing PO it was also received against. */
  received_against_po_id: number | null
  received_against_po_no: string | null
  received_against_qty:            string | number | null
  received_against_received_qty:   string | number | null
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
