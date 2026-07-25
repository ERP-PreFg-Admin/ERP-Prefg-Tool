"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
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
        <div className="inline-flex rounded-lg border border-input p-0.5 bg-background">
          {(["rm", "pm"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                (mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")
              }
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <DownloadButton
          endpoint={`/api/manufacturing/${mfgId}/agreed-rates/export`}
          label={`Agreed ${mode.toUpperCase()} Rates`}
          extraParams={{ mode }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
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
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
