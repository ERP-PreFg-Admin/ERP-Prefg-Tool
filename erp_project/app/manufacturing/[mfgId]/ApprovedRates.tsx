"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import type {
  RmVendorHistoryRow, RmVendorRow, PmVendorHistoryRow, PmVendorRow,
} from "@/types/masters"
import { fmtDate, fmtMoney } from "../mfg-utils"

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Make</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Vendor Code</TableHead>
                  <TableHead>Vendor Name</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Effective From</TableHead>
                  <TableHead>Effective To</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mode === "rm" ? (
                  rmRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground py-10 text-xs">
                        No RM agreed to this manufacturer yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rmRows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{r.rm_code ?? "—"}</TableCell>
                        <TableCell className="text-xs max-w-40 truncate">{r.rm_name}</TableCell>
                        <TableCell className="text-xs">{r.make ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.type ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.approved_vendor_code ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.vendor_name ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtMoney(r.curr_rate)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">Ongoing</TableCell>
                        <TableCell><Badge variant={r.status === "active" ? "success" : "secondary"} className="capitalize">{r.status}</Badge></TableCell>
                      </TableRow>
                    ))
                  )
                ) : (
                  pmRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground py-10 text-xs">
                        No PM agreed to this manufacturer yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    pmRows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{r.pm_code ?? "—"}</TableCell>
                        <TableCell className="text-xs max-w-40 truncate">{r.pm_name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">—</TableCell>
                        <TableCell className="text-xs">{r.type ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.approved_vendor_code ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.vendor_name ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtMoney(r.curr_rate)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {r.effective_to ? fmtDate(r.effective_to) : <span className="text-muted-foreground">Ongoing</span>}
                        </TableCell>
                        <TableCell><Badge variant={r.status === "active" ? "success" : "secondary"} className="capitalize">{r.status}</Badge></TableCell>
                      </TableRow>
                    ))
                  )
                )}
              </TableBody>
            </Table>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Vendor Name</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead>Effective From</TableHead>
                    <TableHead>Effective To</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mode === "rm" ? (
                    rmHistoryRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-10 text-xs">
                          No superseded rates yet — every rate change is archived here.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rmHistoryRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-xs">{r.rm_code ?? "—"}</TableCell>
                          <TableCell className="text-xs max-w-40 truncate">{r.rm_name}</TableCell>
                          <TableCell className="text-xs">{r.vendor_name ?? "—"}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{fmtMoney(r.rate)}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_to)}</TableCell>
                        </TableRow>
                      ))
                    )
                  ) : (
                    pmHistoryRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-10 text-xs">
                          No superseded rates yet — every rate change is archived here.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pmHistoryRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-xs">{r.pm_code ?? "—"}</TableCell>
                          <TableCell className="text-xs max-w-40 truncate">{r.pm_name}</TableCell>
                          <TableCell className="text-xs">{r.vendor_name ?? "—"}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{fmtMoney(r.rate)}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.effective_to)}</TableCell>
                        </TableRow>
                      ))
                    )
                  )}
                </TableBody>
              </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
