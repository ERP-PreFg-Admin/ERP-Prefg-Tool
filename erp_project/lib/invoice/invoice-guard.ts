/**
 * Entity-scope guard for routes that address a supplier invoice by id.
 *
 * The same shape and the same reason as lib/po/po-guard.ts: the invoice LIST is
 * filtered in SQL by INVOICE_WHERE (mfg + destination + brand), but
 * `selectInvoiceById` is a bare `WHERE si.id = ?` returning `si.*` — seller and
 * buyer GSTIN, bill-to address, per-line rates. Invoice ids are sequential
 * integers, so without this a user scoped to one manufacturer reads every
 * manufacturer's invoices by incrementing the id.
 *
 * Separate file rather than lib/scope.ts, to avoid the import cycle:
 * lib/queries/supplier-invoices.ts imports scopeParams from lib/scope.ts, so
 * lib/scope.ts must not import the query file back.
 */

import { query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { getUserScope, assertInScope, inScope } from "@/lib/scope"
import { ApiError } from "@/lib/gateway/errors"

/**
 * Throws 404 if the invoice doesn't exist, 403 if it belongs to a manufacturer,
 * destination or brand the user isn't scoped to. Returns the scope row so a
 * caller that needs mfg_id doesn't have to re-fetch it.
 */
export async function assertInvoiceInScope(userId: number, invoiceId: number) {
  const rows = await query<{ id: number; mfg_id: number; destination: string | null }>(
    supplierInvoicesSql.selectInvoiceScopeById,
    [invoiceId]
  )
  const invoice = rows[0]
  if (!invoice) throw new ApiError(404, "not_found", `Invoice id=${invoiceId} not found`)

  const scope = await getUserScope(userId)
  assertInScope(scope, "mfg", invoice.mfg_id)
  // Only when the invoice actually names one — plenty carry no destination, and
  // those can't be out of a warehouse scope.
  if (invoice.destination) assertInScope(scope, "warehouse", invoice.destination)

  // Brand is per LINE: one invoice can legitimately carry several brands' SKUs,
  // so the list's test is "does it contain ANY line I may see". Mirrored here
  // rather than reduced to an all-lines rule — a stricter guard would hide a
  // multi-brand invoice the list happily shows, which reads as a bug, not a
  // boundary. No attributable line means nothing to exclude on.
  const brands = await query<{ brand_id: number }>(
    supplierInvoicesSql.selectInvoiceLineBrandIds,
    [invoiceId]
  )
  if (brands.length > 0 && !brands.some((b) => inScope(scope, "brand", b.brand_id))) {
    throw new ApiError(403, "out_of_scope", "You don't have access to this brand")
  }

  return invoice
}
