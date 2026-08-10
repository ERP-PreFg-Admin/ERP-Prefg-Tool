"use client"

/**
 * Shows the sibling SKUs sharing one SKU's brand + base_sku_sno (i.e. the
 * same base product's size/variant family) — fetched on demand via
 * POST /api/v1/masters/skus { action: "variants" } rather than baked into the
 * paginated list response, since most rows have no siblings.
 */

import { useEffect, useState } from "react"
import { Layers, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StatusBadge } from "@/components/masters/StatusBadge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { SkuVariantRow } from "@/types/masters"

export function SkuVariantsDialog({
  brand,
  onClose,
}: {
  /** Pass null to close. base_sku_sno is required alongside brand when open. */
  brand: { brand: string; base_sku_sno: number; sku_code: string } | null
  onClose: () => void
}) {
  const [variants, setVariants] = useState<SkuVariantRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!brand) return
    setLoading(true)
    setError(null)
    fetch("/api/v1/masters/skus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "variants", brand: brand.brand, base_sku_sno: brand.base_sku_sno }),
    })
      .then((r) => r.json())
      .then((data) => setVariants(data.skus ?? []))
      .catch(() => setError("Failed to load variants"))
      .finally(() => setLoading(false))
  }, [brand])

  return (
    <Dialog open={brand !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" /> Variants of {brand?.sku_code}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="text-center text-destructive text-sm py-8">{error}</p>
          ) : variants.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-8">
              No other variants found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>SKU Type</TableHead>
                  <TableHead>Sub-Category</TableHead>
                  <TableHead>Filling</TableHead>
                  <TableHead>MRP</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {variants.map((v) => (
                  <TableRow key={v.id} className={v.sku_code === brand?.sku_code ? "bg-blue-50 dark:bg-blue-950/30" : ""}>
                    <TableCell className="font-mono text-xs font-medium">{v.sku_code}</TableCell>
                    <TableCell className="font-medium text-wrap">{v.name}</TableCell>
                    <TableCell className="text-muted-foreground">{v.sku_type ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{v.subcategory ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {v.filling != null ? `${v.filling}${v.filling_uom ?? ""}` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {v.mrp != null ? `₹${v.mrp}` : "—"}
                    </TableCell>
                    <TableCell><StatusBadge status={v.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
