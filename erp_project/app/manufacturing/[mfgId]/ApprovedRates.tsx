"use client"

import { useState, type ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { cn } from "@/lib/utils"
import type {
  RmVendorHistoryRow, RmVendorRow, PmVendorHistoryRow, PmVendorRow,
} from "@/types/masters"
import { fmtDate, fmtMoney } from "../mfg-utils"

type Column<T> = {
  key: string
  label: string
  align?: "right"
  className?: string
  render: (row: T) => ReactNode
}

/** One column-config-driven table body — used for both the RM/PM current-rate
 *  tables and their history tables, so a rate row only has one place that
 *  defines how it renders instead of four near-identical copies of the same
 *  <TableHeader>/<TableBody> JSX. */
function DataTable<T>({ columns, rows, emptyMessage }: {
  columns: Column<T>[]
  rows: T[]
  emptyMessage: string
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="text-center py-10 text-xs">
              <EmptyState message={emptyMessage} />
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  className={cn("text-xs", c.align === "right" && "text-right tabular-nums", c.className)}
                >
                  {c.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

function RateStatusBadge({ status }: { status: string | null }) {
  return <Badge variant={status === "active" ? "success" : "secondary"} className="capitalize">{status}</Badge>
}

const RM_RATE_COLUMNS: Column<RmVendorRow>[] = [
  { key: "code", label: "Code", className: "font-mono", render: (r) => r.rm_code ?? "—" },
  { key: "name", label: "Name", className: "max-w-40 truncate", render: (r) => r.rm_name },
  { key: "make", label: "Make", render: (r) => r.make ?? "—" },
  { key: "type", label: "Type", render: (r) => r.type ?? "—" },
  { key: "vendor_code", label: "Vendor Code", className: "font-mono", render: (r) => r.approved_vendor_code ?? "—" },
  { key: "vendor_name", label: "Vendor Name", render: (r) => r.vendor_name ?? "—" },
  { key: "rate", label: "Rate", align: "right", render: (r) => fmtMoney(r.curr_rate) },
  { key: "eff_from", label: "Effective From", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_from) },
  { key: "eff_to", label: "Effective To", className: "whitespace-nowrap text-muted-foreground", render: () => "Ongoing" },
  { key: "status", label: "Status", render: (r) => <RateStatusBadge status={r.status} /> },
]

const PM_RATE_COLUMNS: Column<PmVendorRow>[] = [
  { key: "code", label: "Code", className: "font-mono", render: (r) => r.pm_code ?? "—" },
  { key: "name", label: "Name", className: "max-w-40 truncate", render: (r) => r.pm_name },
  { key: "make", label: "Make", className: "text-muted-foreground", render: () => "—" },
  { key: "type", label: "Type", render: (r) => r.type ?? "—" },
  { key: "vendor_code", label: "Vendor Code", className: "font-mono", render: (r) => r.approved_vendor_code ?? "—" },
  { key: "vendor_name", label: "Vendor Name", render: (r) => r.vendor_name ?? "—" },
  { key: "rate", label: "Rate", align: "right", render: (r) => fmtMoney(r.curr_rate) },
  { key: "eff_from", label: "Effective From", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_from) },
  {
    key: "eff_to", label: "Effective To", className: "whitespace-nowrap",
    render: (r) => r.effective_to ? fmtDate(r.effective_to) : <span className="text-muted-foreground">Ongoing</span>,
  },
  { key: "status", label: "Status", render: (r) => <RateStatusBadge status={r.status} /> },
]

const RM_HISTORY_COLUMNS: Column<RmVendorHistoryRow>[] = [
  { key: "code", label: "Code", className: "font-mono", render: (r) => r.rm_code ?? "—" },
  { key: "name", label: "Name", className: "max-w-40 truncate", render: (r) => r.rm_name },
  { key: "vendor_name", label: "Vendor Name", render: (r) => r.vendor_name ?? "—" },
  { key: "rate", label: "Rate", align: "right", render: (r) => fmtMoney(r.rate) },
  { key: "eff_from", label: "Effective From", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_from) },
  { key: "eff_to", label: "Effective To", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_to) },
]

const PM_HISTORY_COLUMNS: Column<PmVendorHistoryRow>[] = [
  { key: "code", label: "Code", className: "font-mono", render: (r) => r.pm_code ?? "—" },
  { key: "name", label: "Name", className: "max-w-40 truncate", render: (r) => r.pm_name },
  { key: "vendor_name", label: "Vendor Name", render: (r) => r.vendor_name ?? "—" },
  { key: "rate", label: "Rate", align: "right", render: (r) => fmtMoney(r.rate) },
  { key: "eff_from", label: "Effective From", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_from) },
  { key: "eff_to", label: "Effective To", className: "whitespace-nowrap", render: (r) => fmtDate(r.effective_to) },
]

const NO_SUPERSEDED_RATES = "No superseded rates yet — every rate change is archived here."

export default function RmVendorTable({
  mfgId, rmRows, rmHistoryRows, pmRows, pmHistoryRows,
}: {
  mfgId: number
  rmRows: RmVendorRow[]
  rmHistoryRows: RmVendorHistoryRow[]
  pmRows: PmVendorRow[]
  pmHistoryRows: PmVendorHistoryRow[]
}) {
  const [mode, setMode] = useState<"rm" | "pm">("rm")

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center justify-between gap-3">
        <SegmentedToggle
          size="xs"
          className="bg-background"
          options={[{ key: "rm", label: "RM" }, { key: "pm", label: "PM" }]}
          active={mode}
          onSelect={setMode}
        />
        <DownloadButton
          endpoint={`/api/v1/manufacturing/${mfgId}/approved-rates/export`}
          label={`Approved ${mode.toUpperCase()} Rates`}
          extraParams={{ mode }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {mode === "rm" ? (
            <DataTable columns={RM_RATE_COLUMNS} rows={rmRows} emptyMessage="No RM agreed to this manufacturer yet." />
          ) : (
            <DataTable columns={PM_RATE_COLUMNS} rows={pmRows} emptyMessage="No PM agreed to this manufacturer yet." />
          )}
        </CardContent>
      </Card>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold">Rate History</div>
          <DownloadButton
            endpoint={`/api/v1/manufacturing/${mfgId}/approved-rates/history/export`}
            label={`${mode.toUpperCase()} Rate History`}
            extraParams={{ mode }}
          />
        </div>
        <Card>
          <CardContent className="p-0">
            {mode === "rm" ? (
              <DataTable columns={RM_HISTORY_COLUMNS} rows={rmHistoryRows} emptyMessage={NO_SUPERSEDED_RATES} />
            ) : (
              <DataTable columns={PM_HISTORY_COLUMNS} rows={pmHistoryRows} emptyMessage={NO_SUPERSEDED_RATES} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
