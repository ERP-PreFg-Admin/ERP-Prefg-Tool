"use client"

import Link from "next/link"
import { ExternalLink, Loader2 } from "lucide-react"
import { useAsyncData } from "@/lib/hooks/useAsync"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { STATUS_CONFIG } from "@/app/po-tracking/po-procurement/po-types"
import { formatDisplay } from "@/lib/date"
import { cn } from "@/lib/utils"
import { OLD_PO_DAYS, type OpenPoListRow } from "./overview-model"

/** A chip (mfg + olderThanDays) or a cell (mfg + sku). */
export type OpenPoTarget = {
  mfgId: number
  mfgName: string
  skuCode?: string
  skuName?: string | null
  olderThanDays?: number
}

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 })

export function OpenPoListDialog({ target, onClose }: { target: OpenPoTarget | null; onClose: () => void }) {
  const qs = target
    ? new URLSearchParams({
        mfg_id: String(target.mfgId),
        ...(target.skuCode ? { sku_code: target.skuCode } : {}),
        ...(target.olderThanDays != null ? { older_than_days: String(target.olderThanDays) } : {}),
      }).toString()
    : null

  const { data, error, pending } = useAsyncData<OpenPoListRow[]>(
    async (signal) => {
      const res = await fetch(`/api/v1/manufacturing/open-pos?${qs}`, { signal })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? "Failed to load POs")
      return body.pos ?? []
    },
    [qs],
    qs !== null,
  )
  const rows = data ?? []
  const mfgCode = rows[0]?.mfg_code

  const procurementHref = `/po-tracking/po-procurement?${new URLSearchParams({
    status: "open",
    ...(mfgCode ? { mfgCode } : {}),
    ...(target?.skuCode ? { sku: target.skuCode } : {}),
  }).toString()}`

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {target?.olderThanDays != null ? `Open POs older than ${target.olderThanDays} days` : "Open POs"}
            {" — "}{target?.mfgName}
          </DialogTitle>
          {target?.skuCode && (
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-xs">{target.skuCode}</span>
              {target.skuName && <span className="ml-2">{target.skuName}</span>}
            </p>
          )}
        </DialogHeader>

        <div className="overflow-y-auto">
          {pending ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No open POs.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>PO No.</TableHead>
                  <TableHead>PO Date</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                  {!target?.skuCode && <TableHead>SKU</TableHead>}
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.po_no}</TableCell>
                    <TableCell className="text-xs">{formatDisplay(r.date) || "—"}</TableCell>
                    <TableCell className={cn("text-right text-xs tabular-nums", r.age_days > OLD_PO_DAYS && "font-medium text-red-600 dark:text-red-400")}>
                      {r.age_days}d
                    </TableCell>
                    {!target?.skuCode && (
                      <TableCell className="text-xs">
                        <div className="font-mono">{r.sku_code}</div>
                        <div className="max-w-56 truncate text-muted-foreground" title={r.sku_name ?? undefined}>{r.sku_name}</div>
                      </TableCell>
                    )}
                    <TableCell className="text-right text-xs tabular-nums">{fmt(r.qty)}</TableCell>
                    <TableCell className="text-right text-xs font-medium tabular-nums">{fmt(r.open_qty)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_CONFIG[r.status]?.variant ?? "secondary"}>{STATUS_CONFIG[r.status]?.label ?? r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{formatDisplay(r.expected_on) || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {rows.length > 0 && (
          <div className="flex justify-end border-t border-border pt-3">
            <Link href={procurementHref} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
              Open in PO Procurement <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
