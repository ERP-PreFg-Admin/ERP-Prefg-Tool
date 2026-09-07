// /observability > Business — domain counts, tenant-wide (see lib/services/business.ts).

import { redirect } from "next/navigation"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { StaticTableHead } from "@/components/ui/sortable-table-head"
import { TableEmpty } from "@/components/ui/empty-state"
import Sparkline from "@/components/observability/Sparkline"
import { count as int, pct, range } from "@/components/observability/format"
import { auth } from "@/lib/auth"
import { getBusinessMetrics } from "@/lib/services/business"
import { isoDate } from "@/lib/date"
import { cn } from "@/lib/utils"

/** Aging is the actionable part of a pending queue — a count alone doesn't say
 *  whether anyone is waiting. */
function age(hours: number): string {
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function Fact({ value, label, tone = "quiet" }: { value: string; label: string; tone?: "quiet" | "warn" }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-foreground"
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  )
}

export default async function ObservabilityBusinessPage() {
  const session = await auth()
  if (!session) redirect("/auth/signin")

  const { poStatuses, poSummary, approvals, approvalThroughput, invoiceWeeks } =
    await getBusinessMetrics(Number(session.user.id), session.user.roles ?? [])

  const fillRate = poSummary.committed_qty
    ? (poSummary.received_qty / poSummary.committed_qty) * 100
    : null
  const pendingTotal = approvals.reduce((sum, a) => sum + a.pending, 0)

  return (
    <div className="space-y-7">
      <p className="text-xs text-muted-foreground">
        Counts across the whole tenant, not scoped to your data access — this page is
        developer-only for that reason.
      </p>

      <section>
        <h2 className="mb-2 text-sm font-medium">Purchase orders</h2>
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-2.5
                     [&>*+*]:before:mr-4 [&>*+*]:before:text-border [&>*+*]:before:content-['/']"
        >
          <Fact value={int(poSummary.total)} label="POs" />
          <Fact value={int(poSummary.open_qty)} label="units open" />
          {/* Left as "no data" rather than 0% when nothing is committed — a zero
              denominator is not a zero fill rate. */}
          <Fact value={fillRate === null ? "no data" : pct(fillRate)} label="fill rate" />
          {poSummary.overdue_pos > 0 && (
            <Fact value={int(poSummary.overdue_pos)} label="POs overdue" tone="warn" />
          )}
          {poSummary.draft_pos > 0 && (
            <Fact value={int(poSummary.draft_pos)} label="unraised drafts" tone="warn" />
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
          {poStatuses.length === 0 ? (
            <p className="text-xs text-muted-foreground">No purchase orders.</p>
          ) : (
            poStatuses.map((s) => (
              <span key={s.status} className="inline-flex items-baseline gap-1.5">
                <span className="font-mono text-xs tabular-nums text-foreground">{int(s.cnt)}</span>
                <span className="text-xs text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
              </span>
            ))
          )}
        </div>
        {/* Same derivation the tabs and badges use, so this can't disagree with
            what PO Tracking shows. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Displayed status, not stored — a raised PO with no mail sent reads as a draft.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">
          Approvals pending
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {pendingTotal === 0 ? "queue is empty" : `${int(pendingTotal)} waiting`}
          </span>
        </h2>
        <div className="overflow-x-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <StaticTableHead width="160px">Module</StaticTableHead>
                <StaticTableHead width="100px">Pending</StaticTableHead>
                <StaticTableHead width="110px">Oldest</StaticTableHead>
                <StaticTableHead>Waiting since (IST)</StaticTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.length === 0 ? (
                <TableEmpty colSpan={4}>Nothing is waiting for approval.</TableEmpty>
              ) : (
                approvals.map((a) => (
                  <TableRow key={a.module}>
                    <TableCell className="font-mono text-xs text-foreground">{a.module}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {int(a.pending)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "font-mono text-xs tabular-nums",
                        // A week in the queue is a stalled approval, not a busy one.
                        a.oldest_hours >= 168
                          ? "text-destructive font-medium"
                          : a.oldest_hours >= 48
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {age(a.oldest_hours)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.oldest_at ? isoDate(a.oldest_at) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
          <span className="text-xs text-muted-foreground">Last 30 days raised:</span>
          {approvalThroughput.length === 0 ? (
            <span className="text-xs text-muted-foreground">none</span>
          ) : (
            approvalThroughput.map((t) => (
              <span key={t.status} className="inline-flex items-baseline gap-1.5">
                <span className="font-mono text-xs tabular-nums text-foreground">{int(t.cnt)}</span>
                <span className="text-xs text-muted-foreground">{t.status}</span>
              </span>
            ))
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Invoices inwarded</h2>
        {invoiceWeeks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No invoices in the last 12 weeks.</p>
        ) : (
          <div className="flex flex-wrap gap-6">
            <Sparkline
              values={invoiceWeeks.map((w) => w.invoices)}
              label="Invoices / week"
              current={int(invoiceWeeks[invoiceWeeks.length - 1].invoices)}
              hint={(() => {
                const r = range(invoiceWeeks.map((w) => w.invoices))
                return r ? `low ${int(r.min)} · peak ${int(r.max)}` : undefined
              })()}
            />
            <Sparkline
              values={invoiceWeeks.map((w) => w.mfgs)}
              label="Manufacturers / week"
              current={int(invoiceWeeks[invoiceWeeks.length - 1].mfgs)}
              hint={`${int(invoiceWeeks.reduce((s, w) => s + w.invoices, 0))} invoices in 12 weeks`}
            />
            <p className="self-end text-xs text-muted-foreground">
              12 weeks to {isoDate(invoiceWeeks[invoiceWeeks.length - 1].week_start)}, by supplier invoice date
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
