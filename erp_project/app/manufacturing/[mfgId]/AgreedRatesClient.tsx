"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import type { AgreedPmRateRow, AgreedRmRateRow } from "@/types/masters"
import { fmtDate, fmtMoney } from "../mfg-utils"

export default function AgreedRatesClient({
  mfgId, rmRows, pmRows,
}: {
  mfgId: number
  rmRows: AgreedRmRateRow[]
  pmRows: AgreedPmRateRow[]
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
          endpoint={`/api/v1/manufacturing/${mfgId}/agreed-rates/export`}
          label={`Agreed ${mode.toUpperCase()} Rates`}
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
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-10">No agreed RM rates yet.</TableCell>
                    </TableRow>
                  ) : (
                    rmRows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono">{r.code ?? "—"}</TableCell>
                        <TableCell className="max-w-40 truncate">{r.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(r.curr_rate)}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                        <TableCell className="whitespace-nowrap">—</TableCell>
                        <TableCell><Badge variant={r.status === "active" ? "success" : "secondary"} className="capitalize">{r.status}</Badge></TableCell>
                      </TableRow>
                    ))
                  )
                ) : (
                  pmRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-10">No agreed PM rates yet.</TableCell>
                    </TableRow>
                  ) : (
                    pmRows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono">{r.code ?? "—"}</TableCell>
                        <TableCell className="max-w-40 truncate">{r.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(r.curr_rate)}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmtDate(r.effective_to)}</TableCell>
                        <TableCell><Badge variant={r.status === "active" ? "success" : "secondary"} className="capitalize">{r.status}</Badge></TableCell>
                      </TableRow>
                    ))
                  )
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>
    </div>
  )
}
