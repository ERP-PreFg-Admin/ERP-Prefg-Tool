// Domain counts for /observability > Business.
//
// ── THESE COUNTS ARE TENANT-WIDE, NOT SCOPED TO THE CALLER ──────────────────
// UNRESTRICTED is passed deliberately, not by omission. /observability is
// developer-only precisely because it cannot be scoped: the Requests tab already
// shows every user's paths and IPs, and a PO total that changed per viewer would
// be useless as a health number. Granting this page to any other role means
// revisiting this line — see prisma/add_observability_page.sql.

import { ApiError } from "@/lib/gateway/errors"
import { resolveAccess } from "@/lib/permissions"
import { timedQuery } from "@/lib/query-timing"
import { purchaseOrdersSql, buildStatusCountParams } from "@/lib/queries/purchase-orders"
import { businessSql } from "@/lib/queries/observability-business"
import { UNRESTRICTED } from "@/lib/scope"

const PAGE_SLUG = "/observability"

export type StatusCount = { status: string; cnt: number }
export type PoSummary = {
  total: number
  open_qty: number
  committed_qty: number
  received_qty: number
  overdue_qty: number
  overdue_pos: number
  draft_pos: number
}
export type ApprovalPending = {
  module: string
  pending: number
  oldest_at: Date | string | null
  oldest_hours: number
}
export type InvoiceWeek = {
  yearweek: number
  week_start: Date | string
  invoices: number
  mfgs: number
}
export type BusinessMetrics = {
  poStatuses: StatusCount[]
  poSummary: PoSummary
  approvals: ApprovalPending[]
  approvalThroughput: StatusCount[]
  invoiceWeeks: InvoiceWeek[]
}

/** SUM()/AVG() arrive as DECIMAL, i.e. strings, from mysql2 — same hazard as
 *  lib/services/observability.ts. */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

const THROUGHPUT_DAYS = 30
const INVOICE_DAYS = 84

export async function getBusinessMetrics(
  userId: number,
  roles: string[]
): Promise<BusinessMetrics> {
  const access = await resolveAccess(userId, roles, PAGE_SLUG)
  if (access === "none") {
    throw new ApiError(403, "forbidden", "You do not have access to observability.")
  }

  // All filters null, inward POs left in, scope UNRESTRICTED — 27 params.
  const poParams = buildStatusCountParams(null, null, null, null, null, null, null, false, UNRESTRICTED)

  const [statusRows, summaryRows, approvalRows, throughputRows, invoiceRows] = await Promise.all([
    timedQuery<Record<string, unknown>>(purchaseOrdersSql.statusCounts, poParams, { label: "observability.poStatusCounts" }),
    timedQuery<Record<string, unknown>>(purchaseOrdersSql.summaryStats, poParams, { label: "observability.poSummaryStats" }),
    timedQuery<Record<string, unknown>>(businessSql.approvalsPending, [], { label: "observability.approvalsPending" }),
    timedQuery<Record<string, unknown>>(businessSql.approvalsThroughput, [THROUGHPUT_DAYS], { label: "observability.approvalsThroughput" }),
    timedQuery<Record<string, unknown>>(businessSql.invoicesByWeek, [INVOICE_DAYS], { label: "observability.invoicesByWeek" }),
  ])

  const s = summaryRows[0]

  return {
    poStatuses: statusRows
      .map((r) => ({ status: String(r.status ?? "unknown"), cnt: n(r.cnt) }))
      .sort((a, b) => b.cnt - a.cnt),
    poSummary: {
      total: n(s?.total),
      open_qty: n(s?.open_qty),
      committed_qty: n(s?.committed_qty),
      received_qty: n(s?.received_qty),
      overdue_qty: n(s?.overdue_qty),
      overdue_pos: n(s?.overdue_pos),
      draft_pos: n(s?.draft_pos),
    },
    approvals: approvalRows.map((r) => ({
      module: String(r.module),
      pending: n(r.pending),
      oldest_at: (r.oldest_at as Date | string | null) ?? null,
      oldest_hours: n(r.oldest_hours),
    })),
    approvalThroughput: throughputRows.map((r) => ({ status: String(r.status), cnt: n(r.cnt) })),
    invoiceWeeks: invoiceRows.map((r) => ({
      yearweek: n(r.yearweek),
      week_start: r.week_start as Date | string,
      invoices: n(r.invoices),
      mfgs: n(r.mfgs),
    })),
  }
}
