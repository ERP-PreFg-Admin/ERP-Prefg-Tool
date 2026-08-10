/**
 * Split children for a page of master POs.
 *
 * PO Tracking lists masters only — a split child belongs to its parent and is
 * reached by expanding that row (see the split expressions in
 * lib/queries/purchase-orders.ts for why). Both PO pages need the same lookup
 * right after their main query, so it lives here rather than being written
 * twice.
 *
 * One query for the whole page, not one per row: splits are rare and few, and
 * a per-row fetch would put a spinner inside a table row to save a join.
 */

import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import type { PoRow } from "@/app/po-tracking/po-procurement/po-types"

export async function fetchChildrenByParent(rows: PoRow[]): Promise<Record<string, PoRow[]>> {
  // Only masters that actually have children are worth asking about — on a page
  // with no splits at all this skips the query entirely.
  const parents = rows.filter((r) => Number(r.child_count) > 0).map((r) => r.po_no)
  if (parents.length === 0) return {}

  const children = await query<PoRow>(purchaseOrdersSql.buildSelectChildren(parents.length), parents)

  const byParent: Record<string, PoRow[]> = {}
  for (const child of children) {
    const key = child.reference_po
    if (!key) continue
    ;(byParent[key] ??= []).push(child)
  }
  return byParent
}
