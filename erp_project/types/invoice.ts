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
  remaining:    string | number
  expected_on:  string | null
  status:       string
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
