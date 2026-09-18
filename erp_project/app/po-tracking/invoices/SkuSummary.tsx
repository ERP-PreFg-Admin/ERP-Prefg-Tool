"use client"

// A compact per-SKU roll-up, shared by the line items, receipts and orders
// views so the three read the same way. The arithmetic lives in
// lib/invoice/three-way.ts; this only lays it out.

import { cn } from "@/lib/utils"

export default function SkuSummary({ title, head, rows, foot, note }: {
  title: string
  /** Column labels. The first is the SKU column; the rest are right-aligned
   *  because every one of them is a number. */
  head: readonly string[]
  /** One array per SKU, same length as `head`. */
  rows: readonly (readonly React.ReactNode[])[]
  /** Optional totals line, same length as `head`. Saves adding up six SKUs by
   *  eye, which is the first thing anyone does otherwise. */
  foot?: readonly React.ReactNode[]
  note?: React.ReactNode
}) {
  // One row per SKU when every SKU appears once is the line list again, under a
  // heading. Say so rather than printing a copy.
  if (rows.length === 0) return null

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-baseline gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[11px]">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{rows.length} SKU{rows.length === 1 ? "" : "s"}</span>
        {note && <span className="ml-auto text-muted-foreground">{note}</span>}
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="[&>th]:whitespace-nowrap [&>th]:px-1.5 [&>th]:py-1 [&>th]:font-medium [&>th]:text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={i === 0 ? "text-left" : "text-right"}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
              {r.map((c, ci) => (
                <td
                  key={ci}
                  className={cn(
                    ci === 0 ? "text-left font-medium" : "text-right tabular-nums",
                    ci === 0 && "max-w-40 truncate"
                  )}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot className="border-t-2 border-border">
            <tr className="[&>td]:px-1.5 [&>td]:py-1 [&>td]:font-medium">
              {foot.map((c, i) => (
                <td key={i} className={i === 0 ? "text-left text-muted-foreground" : "text-right tabular-nums"}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
