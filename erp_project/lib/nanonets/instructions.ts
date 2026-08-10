/**
 * The shared extraction rules, sent as `extraction_config.custom_instructions`.
 *
 * Every supplier gets these. A manufacturer whose format needs more adds its own
 * rules through a strategy (./strategies/) rather than editing this list — a rule
 * here has to be true of every invoice we receive.
 *
 * An array, joined by the builder. It used to be a joined string here, and before
 * that a comma-expression, which silently kept only the last fragment and dropped
 * every other rule. Keeping it a string[] to the last moment makes that class of
 * mistake a type error instead of a silent one.
 */
export const BASE_INSTRUCTIONS: string[] = [
  "Extract each product row as a separate object in line_items.",
  "Return ALL dates (date, mfg_date, expiry) in dd-mmm-yy format, e.g. 05-Jul-25.",
  "Strip currency symbols and thousands separators from all numeric fields;",
  "return qty, rate, mrp, discount, amount, gst_percent and total_amount as plain numbers.",
  "gst_percent is the tax rate (e.g. 18), not the tax amount.",
  "Read every line_items field across that one printed row of the item table.",
  // The money rules exist because many invoices apply GST once in the footer and
  // print no per-row tax-inclusive column. Null is then the correct answer, and a
  // derived figure would be fabricated money that gets persisted.
  "amount is the row's pre-tax value; total_amount is the row's tax-inclusive value.",
  "Take total_amount only from a printed per-row column such as 'Total', 'Line Total' or 'Amount (incl. GST)' — usually the rightmost money column of the row.",
  "When the item table prints only one money column per row, that column is amount; leave total_amount null.",
  "Never calculate total_amount from rate, qty or gst_percent.",
  "mrp and discount come from printed M.R.P. and Discount columns only; leave them null when the table has no such column.",
  "from is the seller's registered legal name as printed in the header, with its entity suffix (PVT LTD, PRIVATE LIMITED, LLP). Prefer it over a shorter trade or brand name printed on the same invoice.",
  "'Buyer (Bill to)' and 'Consignee (Ship to)' are separate blocks — extract each into its own",
  "bill_to_* / ship_to_* fields even when both name the same party.",
  "Those blocks may be labelled Buyer, Bill To, Billed To, Sold To, Consignee, Ship To, Shipped To or Delivery Address; match on what the label means, not its exact wording.",
  "When one party block serves as both, repeat its values into bill_to_* and ship_to_* rather than leaving either set empty.",
  "purchase_order is the buyer's order reference in the header, labelled PO No, P.O. No, Order No, Buyer's Order No or Your Order No. Return the reference only, without the label.",
  // Stays last: it is the fallback every rule above defers to.
  "If a field is not present on the document, return null. Do not guess or fabricate values.",
]

/** Documented cap on `custom_instructions` (Nanonets ExtractConfig). */
export const MAX_INSTRUCTION_CHARS = 8000
