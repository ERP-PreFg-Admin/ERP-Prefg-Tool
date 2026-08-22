"use client"

/**
 * Shows the sibling SKUs sharing one SKU's brand + base_sku_sno (i.e. the
 * same base product's size/variant family) — fetched on demand via
 * POST /api/v1/masters/skus { action: "variants" } rather than baked into the
 * paginated list response, since most rows have no siblings.
 *
 * Also the ONLY place a family's base SKU is designated. The base owns the
 * family's RM formulation: Recipe Master locks RM on every other member and
 * only lets it change from here (see lib/masters/variant-rm-lock.ts). This is
 * the one screen where the whole family is visible at once, so it is the only
 * sane home for that pick.
 */

import { useEffect, useState } from "react"
import { Layers, Loader2, Star } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StatusBadge } from "@/components/masters/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
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
  const { toast } = useToast()
  const [variants, setVariants] = useState<SkuVariantRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingBaseId, setSavingBaseId] = useState<number | null>(null)

  useEffect(() => {
    if (!brand) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results before the new brand's fetch resolves
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

  async function setBase(sku: SkuVariantRow) {
    setSavingBaseId(sku.id)
    try {
      const res = await fetch("/api/v1/masters/skus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-base", sku_id: sku.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to set base SKU")
      // The server clears the family's other flags in the same transaction, so
      // mirror that locally rather than refetching — exactly one base, always.
      setVariants((rows) => rows.map((r) => ({ ...r, is_base_sku: r.id === sku.id ? 1 : 0 })))
      toast({ title: "Base SKU set", description: `${sku.sku_code} now owns this family's RM.`, variant: "success" })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "An error occurred"
      toast({ title: "Failed to set base SKU", description: message, variant: "error" })
    } finally {
      setSavingBaseId(null)
    }
  }

  return (
    <Dialog open={brand !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
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
            <>
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                These SKUs are the same formulation in different pack sizes, so they
                share one RM recipe. The <strong>base SKU</strong> owns that RM —
                every other variant can only change its PM.
                {!variants.some((v) => v.is_base_sku) && " No base is set yet, so RM is inherited from whichever variant last got a recipe."}
              </p>
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
                    <TableHead>RM Owner</TableHead>
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
                      <TableCell>
                        {v.is_base_sku ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <Star className="h-3 w-3" /> Base
                          </Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={savingBaseId != null}
                            onClick={() => setBase(v)}
                          >
                            {savingBaseId === v.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Set as base"
                            )}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
