/**
 * The field set handed to the extractor as `extraction_config.json_options`.
 *
 * Mirrors types/invoice.ts — a key added here needs the matching field on
 * ParsedInvoice / ParsedLineItem, or normalizeParsedInvoice will drop it into
 * `extra` instead of the typed shape.
 *
 * A field's `description` is the most direct lever on extraction quality: it
 * travels with the schema on every call and, because prompt_mode is "append",
 * composes with the shared rules in ./instructions.ts rather than being
 * replaced by them.
 */

import type { ParsedLineItem } from "@/types/invoice"

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    date:             { type: "string", description: "Invoice date in dd-mmm-yy format, e.g. 05-Jul-25" },
    // Backs UNIQUE (mfg_id, invoice_no) on invoice_mfg — a misread here
    // defeats the duplicate guard and the same invoice can be inwarded twice.
    invoice_number:   { type: "string", description: "Invoice / bill number exactly as printed, including any series prefix and slashes, e.g. RP/L/26-27/482. Not the E-way Bill, IRN or Acknowledgement number." },
    eway_bill_number: { type: "string", description: "E-way bill number, usually 12 digits, labelled 'e-Way Bill No'" },
    // matchMfg (lib/invoice-mapping.ts) tries registered_name before name,
    // because the master holds the legal entity and the invoice header prints it.
    from:             { type: "string", description: "Seller / consignor registered legal name from the invoice header, with its entity suffix — not the short trade or brand name" },
    destination:      { type: "string", description: "Consignee / ship-to location" },
    vehicle_number:   { type: "string", description: "Vehicle / lorry registration number carrying the goods, e.g. MH48AG3908" },
    currency:         { type: "string", description: "Currency code, e.g. INR" },
    seller_gstin:     { type: "string", description: "Seller / consignor GSTIN" },
    buyer_gstin:      { type: "string", description: "Buyer / consignee GSTIN" },
    bill_to_name:     { type: "string", description: "Buyer / Bill-to party name, from the 'Buyer (Bill to)' block, however it is labelled ('Billed To', 'Sold To')" },
    bill_to_address:  { type: "string", description: "Buyer / Bill-to full postal address as one line, from the 'Buyer (Bill to)' block. Exclude the GSTIN and party name." },
    bill_to_gstin:    { type: "string", description: "GSTIN printed inside the 'Buyer (Bill to)' block" },
    bill_to_state:    { type: "string", description: "State name printed inside the 'Buyer (Bill to)' block" },
    ship_to_name:     { type: "string", description: "Consignee / Ship-to party name, from the 'Consignee (Ship to)' block, however it is labelled ('Shipped To', 'Delivery Address')" },
    ship_to_address:  { type: "string", description: "Consignee / Ship-to full postal address as one line. Exclude the GSTIN and party name." },
    purchase_order:   { type: "string", description: "Buyer's purchase order / order reference printed in the header, labelled 'PO No', 'Order No' or 'Buyer's Order No'. Return the reference only, without the label." },
    total_amount:     { type: "number", description: "Grand total of the invoice, including tax" },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sku_code:     { type: "string", description: "Product/item code, often a prefix of the description e.g. Mcaf407" },
          sku_name:     { type: "string", description: "Product description with the item code removed" },
          batch:        { type: "string", description: "Batch / lot number printed on the row" },
          mfg_date:     { type: "string", description: "dd-mmm-yy" },
          expiry:       { type: "string", description: "dd-mmm-yy" },
          qty:          { type: "number" },
          hsn:          { type: "string", description: "HSN or SAC code printed on the row, digits only — not the item code" },
          rate:         { type: "number", description: "Price per unit before tax" },
          mrp:          { type: "number", description: "Maximum retail price per unit, from a printed M.R.P. column. Null when the table has no MRP column." },
          discount:     { type: "number", description: "Discount for this row in currency units, not a percentage. Null when the table has no discount column." },
          amount:       { type: "number", description: "The row's printed pre-tax value (rate x qty, less any discount)" },
          gst_percent:  { type: "number", description: "GST rate as a number, e.g. 18" },
          // Null is a legitimate answer: many invoices apply GST once in the
          // footer and print no per-row tax-inclusive column at all. Deriving
          // it would fabricate money that toInwardPayload persists.
          total_amount: { type: "number", description: "The row's printed tax-inclusive total, from a per-row 'Total' or 'Amount (incl. GST)' column. Null when the table prints no such column — never derive it." },
        },
      },
    },
  },
} as const

/** Fields we model explicitly; everything else lands in ParsedInvoice.extra. */
export const KNOWN_KEYS = new Set([...Object.keys(EXTRACTION_SCHEMA.properties), "line_items"])

export const LINE_KEYS = Object.keys(
  EXTRACTION_SCHEMA.properties.line_items.items.properties
) as (keyof ParsedLineItem)[]

/** Hand-written rather than derived: the schema's `type` is the extractor's
 *  instruction, not a guarantee, so coercion is decided here. */
export const NUMERIC_LINE_KEYS = new Set([
  "qty", "rate", "mrp", "discount", "amount", "gst_percent", "total_amount",
])
